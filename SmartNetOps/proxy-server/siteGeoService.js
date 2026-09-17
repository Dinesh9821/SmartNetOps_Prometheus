"use strict";

/**
 * Site geo service — powers the global map.
 *
 * Joins three sources that nobody had joined before:
 *   1. /proxy1 (siteIdGet)  -> the authoritative site list, per region
 *   2. coordinate resolution -> cache, then Geocoding, then centroid
 *   3. Prometheus            -> live health per site_id
 *
 * The frontend receives GeoJSON-ish rows and never issues PromQL or a
 * geocoding call itself.
 *
 * BACKEND CONTRACT NOTE
 *   /proxy1 is called with exactly the payload shape the existing pages use
 *   ({region, country}) and its response is parsed with the same tolerant
 *   reader. Nothing about that upstream contract is altered here.
 */

const fs = require("fs");
const path = require("path");
const {
  PrometheusClient, samples, scalarFrom
} = require("./prometheusClient");
const { escapeLabel } = require("./monitoringService");
const {
  COUNTRY, PREFIX_COUNTRY, COUNTRY_REGION,
  US_STATE, US_STATE_NAME, REGION_VIEW
} = require("./geoRef");

const SITE_API = process.env.SITE_API_URL ||
  "http://cussya5y.carcgl.com:7777/siteIdGet";
const SITE_API_AUTH = process.env.SITE_API_AUTH ||
  "Basic ZGluZXNoOmRpbmVzaDEyMw==";

const GEOCODE_KEY = process.env.GOOGLE_MAPS_SERVER_KEY || "";
const COORD_FILE = process.env.SITE_COORDS_FILE ||
  path.join(__dirname, "site-coords.json");

const REGIONS = ["APAC", "EMEA", "AMER", "CHINA"];
const TTL_MS = Number(process.env.SITE_GEO_TTL_MS || 10 * 60 * 1000);

/* ------------------------------------------------------- coordinate store */

let coordCache = null;

function loadCoords() {
  if (coordCache) return coordCache;
  coordCache = {};
  try {
    if (fs.existsSync(COORD_FILE)) {
      const raw = JSON.parse(fs.readFileSync(COORD_FILE, "utf-8"));
      coordCache = raw.sites || raw || {};
    }
  } catch (err) {
    coordCache = {};
  }
  return coordCache;
}

let saveTimer = null;
function persistCoords() {
  if (saveTimer) return;
  saveTimer = setTimeout(function () {
    saveTimer = null;
    try {
      fs.writeFileSync(COORD_FILE,
        JSON.stringify({ sites: coordCache }, null, 2), "utf-8");
    } catch (err) { /* cache is best-effort, never fatal */ }
  }, 2000);
}

/* -------------------------------------------------------------- site list */

/**
 * The pipe-delimited shape is a documented project convention:
 *   "ID | Street | City | State | Country | Postcode"
 * Objects are also accepted, because the upstream has returned both.
 */
function parseSite(entry) {
  if (!entry) return null;

  if (typeof entry === "object") {
    const id = entry.site_id || entry.siteId || entry.id || entry.site || "";
    if (!id) return null;
    return {
      site_id: String(id).trim().toUpperCase(),
      street: entry.street || entry.address || "",
      city: entry.city || "",
      state: entry.state || entry.province || "",
      country: entry.country || "",
      postcode: entry.postcode || entry.zip || entry.postal_code || "",
      lat: numOrNull(entry.lat != null ? entry.lat : entry.latitude),
      lng: numOrNull(entry.lng != null ? entry.lng : entry.longitude)
    };
  }

  const parts = String(entry).split("|").map(function (s) { return s.trim(); });
  if (!parts[0]) return null;
  return {
    site_id: parts[0].toUpperCase(),
    street: parts[1] || "",
    city: parts[2] || "",
    state: parts[3] || "",
    country: parts[4] || "",
    postcode: parts[5] || "",
    lat: null, lng: null
  };
}

function numOrNull(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Same tolerant reader the existing pages use against /proxy1. */
function extractList(data) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data && data.sites)) return data.sites;
  if (Array.isArray(data && data.data)) return data.data;
  if (Array.isArray(data && data.result)) return data.result;
  if (data && typeof data === "object") {
    const vals = Object.keys(data).map(function (k) { return data[k]; });
    const flat = [];
    vals.forEach(function (v) {
      if (Array.isArray(v)) flat.push.apply(flat, v);
      else if (v) flat.push(v);
    });
    return flat;
  }
  return [];
}

async function fetchSites(region, country, fetchFn) {
  const doFetch = fetchFn || globalThis.fetch.bind(globalThis);
  const body = { region: region };
  if (country) body.country = country;

  const ctrl = new AbortController();
  const timer = setTimeout(function () { ctrl.abort(); }, 12000);
  try {
    const res = await doFetch(SITE_API, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: SITE_API_AUTH
      },
      body: JSON.stringify(body),
      signal: ctrl.signal
    });
    if (!res.ok) throw new Error("site API HTTP " + res.status);
    const text = await res.text();
    let data = null;
    try { data = JSON.parse(text); } catch (e) { data = null; }
    return extractList(data).map(parseSite).filter(Boolean);
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------------------------------------- geocoding */

async function geocode(site, fetchFn) {
  if (!GEOCODE_KEY) return null;
  const bits = [site.street, site.city, site.state, site.country, site.postcode]
    .filter(Boolean).join(", ");
  if (!bits) return null;
  const doFetch = fetchFn || globalThis.fetch.bind(globalThis);
  const url = "https://maps.googleapis.com/maps/api/geocode/json?address=" +
    encodeURIComponent(bits) + "&key=" + encodeURIComponent(GEOCODE_KEY);
  try {
    const res = await doFetch(url);
    if (!res.ok) return null;
    const body = await res.json();
    if (body.status !== "OK" || !body.results || !body.results.length) return null;
    const loc = body.results[0].geometry && body.results[0].geometry.location;
    if (!loc) return null;
    return { lat: loc.lat, lng: loc.lng, precision: "geocoded" };
  } catch (err) {
    return null;
  }
}

/* --------------------------------------------------- coordinate resolution */

function countryOf(site) {
  if (site.country && COUNTRY[site.country]) return site.country;
  const prefix = String(site.site_id || "").slice(0, 2).toUpperCase();
  return PREFIX_COUNTRY[prefix] || site.country || "";
}

function stateCode(site) {
  const s = String(site.state || "").trim();
  if (!s) return "";
  if (s.length === 2 && US_STATE[s.toUpperCase()]) return s.toUpperCase();
  return US_STATE_NAME[s.toLowerCase()] || "";
}

/** Deterministic scatter so co-located sites do not stack into one pin. */
function jitter(siteId, amount) {
  let h = 0;
  const s = String(siteId);
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  const a = ((h % 1000) / 1000) * Math.PI * 2;
  const r = (((h >> 10) % 1000) / 1000) * amount;
  return [Math.cos(a) * r, Math.sin(a) * r];
}

async function resolveCoords(site, fetchFn) {
  // 1. explicit coordinates from the upstream payload
  if (site.lat != null && site.lng != null) {
    return { lat: site.lat, lng: site.lng, precision: "exact" };
  }

  // 2. cache (which is also where geocoded results land)
  const cache = loadCoords();
  const hit = cache[site.site_id];
  if (hit && hit.lat != null && hit.lng != null) {
    return { lat: hit.lat, lng: hit.lng, precision: hit.precision || "cached" };
  }

  // 3. Geocoding API, only when a server key is configured
  const geo = await geocode(site, fetchFn);
  if (geo) {
    cache[site.site_id] = geo;
    persistCoords();
    return geo;
  }

  // 4. US state centroid
  const country = countryOf(site);
  if (country === "United States") {
    const sc = stateCode(site);
    if (sc && US_STATE[sc]) {
      const j = jitter(site.site_id, 0.9);
      return {
        lat: US_STATE[sc][0] + j[0], lng: US_STATE[sc][1] + j[1],
        precision: "state-centroid"
      };
    }
  }

  // 5. country centroid
  if (country && COUNTRY[country]) {
    const j = jitter(site.site_id, 1.6);
    return {
      lat: COUNTRY[country][0] + j[0], lng: COUNTRY[country][1] + j[1],
      precision: "country-centroid"
    };
  }

  return { lat: null, lng: null, precision: "unresolved" };
}

/* ------------------------------------------------------------ live health */

/**
 * Per-site live health.
 *
 * Uses the same candidate-ladder approach as the network service: the unified
 * recording rules first (which fan in BOTH Meraki and vManage), then vendor
 * rollups, then raw exporter metrics. Querying vmanage_* first — as the first
 * cut did — returns nothing on a Meraki-dominant estate and leaves every
 * marker grey.
 */
async function siteHealth(prom, region) {
  const s = region ? '{region="' + String(region).replace(/"/g, '') + '"}' : "";

  const LADDERS = {
    total: [
      "site_devices_total:all" + s,
      "sum by (region, country, site_id, priority) (device_info" + s + ")",
      "vmanage_site_devices_total" + s,
      "meraki_site_devices_total" + s
    ],
    up: [
      "site_devices_up:all" + s,
      "vmanage_site_devices_reachable" + s,
      "meraki_site_devices_online" + s
    ],
    health: [
      "site_health_percent" + s
    ],
    wanUp: [
      "sum by (region, country, site_id) (wan_link_up" + s + " == 1)",
      "sdwan_site_wan_links_up" + s,
      "vmanage_site_wan_links_up" + s
    ],
    wanTotal: [
      "count by (region, country, site_id) (wan_link_up" + s + ")",
      "sdwan_site_wan_links_total" + s,
      "vmanage_site_wan_links_total" + s
    ],
    bfdUp: [
      'overlay_sessions_up' + (s ? s.slice(0, -1) + ',protocol="bfd"}' : '{protocol="bfd"}'),
      "sum by (region, country, site_id) (vmanage_bfd_sessions_up" + s + ")"
    ],
    bfdTotal: [
      'overlay_sessions_total' + (s ? s.slice(0, -1) + ',protocol="bfd"}' : '{protocol="bfd"}'),
      "sum by (region, country, site_id) (vmanage_bfd_sessions_total" + s + ")"
    ],
    latency: [
      "avg by (site_id) (wan_link_latency_milliseconds" + s + ")",
      "avg by (site_id) (vmanage_bfd_session_latency_ms" + s + ")"
    ],
    loss: [
      "avg by (site_id) (wan_link_loss_percent" + s + ")",
      "avg by (site_id) (vmanage_bfd_session_loss_percent" + s + ")"
    ],
    uptime: [
      "min by (site_id) (vmanage_device_uptime_seconds" + s + ")"
    ]
  };

  async function firstNonEmpty(list) {
    for (let i = 0; i < list.length; i++) {
      try {
        const r = await prom.query(list[i]);
        const sm = samples(r);
        if (sm.length) return { samples: sm, expr: list[i] };
      } catch (err) { /* try the next rung */ }
    }
    return { samples: [], expr: list[list.length - 1] || "" };
  }

  const keys = Object.keys(LADDERS);
  const resolved = {};
  await Promise.all(keys.map(async function (k) {
    resolved[k] = await firstNonEmpty(LADDERS[k]);
  }));

  const out = {};
  function row(sid, metric) {
    if (!out[sid]) {
      out[sid] = {
        devices: null, devices_up: null, health: null,
        wan_links_up: null, wan_links_total: null,
        bfd_up: null, bfd_total: null,
        latency_ms: null, loss_percent: null, uptime_seconds: null,
        region: null, country: null, priority: null
      };
    }
    const r = out[sid];
    if (metric) {
      r.region = r.region || metric.region || null;
      r.country = r.country || metric.country || null;
      r.priority = r.priority || metric.priority || null;
    }
    return r;
  }

  const FIELD = {
    total: "devices", up: "devices_up", health: "health",
    wanUp: "wan_links_up", wanTotal: "wan_links_total",
    bfdUp: "bfd_up", bfdTotal: "bfd_total",
    latency: "latency_ms", loss: "loss_percent", uptime: "uptime_seconds"
  };
  const ADDITIVE = {
    devices: 1, devices_up: 1, wan_links_up: 1,
    wan_links_total: 1, bfd_up: 1, bfd_total: 1
  };

  keys.forEach(function (k) {
    (resolved[k].samples || []).forEach(function (sm) {
      const sid = sm.metric && sm.metric.site_id;
      if (!sid) return;
      const r = row(sid, sm.metric);
      const f = FIELD[k];
      if (f === "uptime_seconds") {
        r[f] = r[f] == null ? sm.value : Math.min(r[f], sm.value);
      } else if (ADDITIVE[f]) {
        r[f] = (r[f] || 0) + sm.value;
      } else {
        r[f] = sm.value;
      }
    });
  });

  const sources = {};
  keys.forEach(function (k) { sources[k] = resolved[k].expr; });
  Object.defineProperty(out, "__sources", { value: sources, enumerable: false });
  return out;
}

function roundInt(v) {
  return v == null || !Number.isFinite(v) ? null : Math.round(v);
}

function round1(v) {
  return v == null || !Number.isFinite(v) ? null : Number(v.toFixed(1));
}

function statusOf(h) {
  if (!h) return "NO_DATA";
  // site_health_percent is authoritative when the unified rules are loaded;
  // otherwise derive it from the device counts.
  let pct = h.health;
  if (pct == null) {
    if (!h.devices) return "NO_DATA";
    pct = 100 * (h.devices_up || 0) / h.devices;
  }
  if (pct >= 99) return "HEALTHY";
  if (pct >= 90) return "DEGRADED";
  if (pct > 0) return "CRITICAL";
  return "DOWN";
}

/* -------------------------------------------------------------- main call */

const memo = { key: null, at: 0, data: null };

async function getSiteMap(regionRaw, opts) {
  opts = opts || {};
  const region = REGIONS.indexOf(String(regionRaw || "").toUpperCase()) >= 0
    ? String(regionRaw).toUpperCase() : "";
  const cacheKey = region || "GLOBAL";

  if (!opts.noCache && memo.key === cacheKey && Date.now() - memo.at < TTL_MS) {
    return Object.assign({}, memo.data, { cached: true });
  }

  const targets = region ? [region] : REGIONS;
  const siteRows = [];
  const sourceErrors = [];

  await Promise.all(targets.map(async function (r) {
    try {
      const list = await fetchSites(r, "", opts.fetchFn);
      list.forEach(function (s) {
        s._region = r;
        siteRows.push(s);
      });
    } catch (err) {
      sourceErrors.push({ region: r, error: String(err.message || err) });
    }
  }));

  // de-duplicate: a site can legitimately be returned by more than one call
  const seen = {};
  const unique = [];
  siteRows.forEach(function (s) {
    if (seen[s.site_id]) return;
    seen[s.site_id] = true;
    unique.push(s);
  });

  let health = {};
  let promError = null;
  try {
    const prom = opts.prom || new PrometheusClient();
    health = await siteHealth(prom, region);
  } catch (err) {
    promError = String(err.message || err);
  }

  const features = [];
  for (let i = 0; i < unique.length; i++) {
    const s = unique[i];
    const coords = await resolveCoords(s, opts.fetchFn);
    const h = health[s.site_id] || null;
    const country = countryOf(s);
    const reg = (h && h.region) || s._region ||
      COUNTRY_REGION[country] || "";

    features.push({
      site_id: s.site_id,
      region: reg || null,
      country: country || s.country || null,
      state: s.state || null,
      city: s.city || null,
      street: s.street || null,
      postcode: s.postcode || null,
      priority: (h && h.priority) || null,
      lat: coords.lat,
      lng: coords.lng,
      precision: coords.precision,
      status: statusOf(h),
      monitored: !!h,
      devices: h ? roundInt(h.devices) : null,
      devices_up: h ? roundInt(h.devices_up) : null,
      availability: h
        ? round1(h.health != null ? h.health
            : (h.devices ? 100 * (h.devices_up || 0) / h.devices : null))
        : null,
      wan_links_up: h ? h.wan_links_up : null,
      wan_links_total: h ? h.wan_links_total : null,
      bfd_up: h ? h.bfd_up : null,
      bfd_total: h ? h.bfd_total : null,
      latency_ms: h ? round1(h.latency_ms) : null,
      loss_percent: h ? round1(h.loss_percent) : null,
      uptime_days: h && h.uptime_seconds != null
        ? round1(h.uptime_seconds / 86400) : null
    });
  }

  features.sort(function (a, b) {
    return String(a.site_id).localeCompare(String(b.site_id));
  });

  const byRegion = {};
  const byCountry = {};
  const precision = {};
  features.forEach(function (f) {
    const r = f.region || "UNKNOWN";
    const c = f.country || "Unknown";
    byRegion[r] = (byRegion[r] || 0) + 1;
    byCountry[c] = (byCountry[c] || 0) + 1;
    precision[f.precision] = (precision[f.precision] || 0) + 1;
  });

  const payload = {
    region: region || null,
    view: REGION_VIEW[region || "GLOBAL"] || REGION_VIEW.GLOBAL,
    generated_at: new Date().toISOString(),
    total: features.length,
    placed: features.filter(function (f) { return f.lat != null; }).length,
    monitored: features.filter(function (f) { return f.monitored; }).length,
    status_counts: {
      HEALTHY:  features.filter(function (f) { return f.status === "HEALTHY"; }).length,
      DEGRADED: features.filter(function (f) { return f.status === "DEGRADED"; }).length,
      CRITICAL: features.filter(function (f) { return f.status === "CRITICAL"; }).length,
      DOWN:     features.filter(function (f) { return f.status === "DOWN"; }).length,
      NO_DATA:  features.filter(function (f) { return f.status === "NO_DATA"; }).length
    },
    by_region: byRegion,
    by_country: byCountry,
    precision_counts: precision,
    geocoding_enabled: !!GEOCODE_KEY,
    source_errors: sourceErrors,
    prometheus_error: promError,
    sites: features
  };

  memo.key = cacheKey;
  memo.at = Date.now();
  memo.data = payload;
  return payload;
}

module.exports = {
  getSiteMap,
  parseSite,
  extractList,
  resolveCoords,
  countryOf,
  stateCode,
  statusOf,
  REGIONS,
  REGION_VIEW
};
