"use strict";

/**
 * Network Global / CXO network service.
 *
 * All PromQL now comes from metricCatalog.js, which resolves each logical
 * metric through a candidate ladder: unified recording rule -> vendor rollup
 * -> raw exporter metric. See that file for why the layering matters.
 *
 * The browser still sends scope only and never PromQL. Every response reports
 * which expression actually produced each value (`sources`), so a blank panel
 * can always be traced without guessing.
 */

const {
  PrometheusClient,
  samples,
  scalarFrom,
  latestTsFromResults,
  isoFromUnix
} = require("./prometheusClient");
const { extractSiteId, validateSiteId } = require("./monitoringService");
const CAT = require("./metricCatalog");

const REGIONS = ["APAC", "EMEA", "AMER", "CHINA"];

function normalizeRegion(raw) {
  if (!raw) return "";
  const up = String(raw).trim().toUpperCase();
  if (!up || up === "ALL" || up === "GLOBAL") return "";
  return REGIONS.indexOf(up) >= 0 ? up : "";
}

const THROUGHPUT_RANGES = {
  "5m":  { seconds: 5 * 60,             step: 10,    label: "Last 5 minutes" },
  "15m": { seconds: 15 * 60,            step: 15,    label: "Last 15 minutes" },
  "1h":  { seconds: 60 * 60,            step: 30,    label: "Last 1 hour" },
  "6h":  { seconds: 6 * 60 * 60,        step: 120,   label: "Last 6 hours" },
  "24h": { seconds: 24 * 60 * 60,       step: 300,   label: "Last 24 hours" },
  "7d":  { seconds: 7 * 24 * 60 * 60,   step: 1800,  label: "Last 7 days" },
  "30d": { seconds: 30 * 24 * 60 * 60,  step: 3600,  label: "Last 30 days" },
  "90d": { seconds: 90 * 24 * 60 * 60,  step: 10800, label: "Last 90 days" },
  "6m":  { seconds: 182 * 24 * 60 * 60, step: 21600, label: "Last 6 months" },
  "1y":  { seconds: 365 * 24 * 60 * 60, step: 86400, label: "Last 1 year" }
};

function resolveRange(k) { return THROUGHPUT_RANGES[k] ? k : "1h"; }

/* ---------------------------------------------------------------- helpers */

function rec(value, extra) {
  const ok = value != null && Number.isFinite(value);
  return Object.assign({ value: ok ? value : null, available: ok }, extra || {});
}
function roundInt(v) { return v == null || !Number.isFinite(v) ? null : Math.round(v); }
function round1(v)  { return v == null || !Number.isFinite(v) ? null : Number(v.toFixed(1)); }
function downFrom(total, up) { return total == null ? null : Math.max(total - (up || 0), 0); }

function rangeValues(result) {
  if (!result || !result.length) return [];
  const buckets = {};
  result.forEach(function (s) {
    (s.values || []).forEach(function (p) {
      const n = Number(p && p[1]);
      if (!Number.isFinite(n)) return;
      buckets[Number(p[0])] = (buckets[Number(p[0])] || 0) + n;
    });
  });
  return Object.keys(buckets).sort(function (a, b) { return a - b; })
    .map(function (t) { return [Number(t), buckets[t]]; });
}

/**
 * Resolve one logical metric by walking its candidate ladder.
 * Returns { value, expr, rung } -- rung 0 means the preferred source won.
 */
async function resolveScalar(prom, candidates, trace, key) {
  for (let i = 0; i < candidates.length; i++) {
    const expr = candidates[i];
    try {
      const result = await prom.query(expr);
      const v = scalarFrom(result);
      if (trace) trace.push({ key: key, expr: expr, rung: i, series: (result || []).length, ok: true });
      if (v != null) return { value: v, expr: expr, rung: i };
    } catch (err) {
      if (trace) trace.push({ key: key, expr: expr, rung: i, ok: false, error: err.message });
    }
  }
  return { value: null, expr: candidates[candidates.length - 1] || "", rung: -1 };
}

async function resolveSeries(prom, candidates, trace, key) {
  for (let i = 0; i < candidates.length; i++) {
    const expr = candidates[i];
    try {
      const result = await prom.query(expr);
      const list = samples(result);
      if (trace) trace.push({ key: key, expr: expr, rung: i, series: list.length, ok: true });
      if (list.length) return { samples: list, expr: expr, rung: i };
    } catch (err) {
      if (trace) trace.push({ key: key, expr: expr, rung: i, ok: false, error: err.message });
    }
  }
  return { samples: [], expr: candidates[candidates.length - 1] || "", rung: -1 };
}

async function resolveRangeSeries(prom, candidates, start, end, step, trace, key) {
  for (let i = 0; i < candidates.length; i++) {
    const expr = candidates[i];
    try {
      const result = await prom.queryRange(expr, start, end, step);
      const pts = rangeValues(result);
      if (trace) trace.push({ key: key, expr: expr, rung: i, points: pts.length, ok: true, range: true });
      if (pts.length) return { points: pts, expr: expr, rung: i };
    } catch (err) {
      if (trace) trace.push({ key: key, expr: expr, rung: i, ok: false, error: err.message, range: true });
    }
  }
  return { points: [], expr: candidates[candidates.length - 1] || "", rung: -1 };
}

/** Run a map of logical metrics concurrently through their ladders. */
async function resolveMany(prom, spec, s, trace, concurrency) {
  const keys = Object.keys(spec);
  const out = {};
  let i = 0;
  const limit = Math.max(1, concurrency || 6);
  async function worker() {
    while (i < keys.length) {
      const k = keys[i++];
      out[k] = await resolveScalar(prom, spec[k](s), trace, k);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, keys.length) }, worker));
  return out;
}

function val(r, k) { return r[k] ? r[k].value : null; }

/* ------------------------------------------------------------------- kpis */

function buildKpis(r) {
  const devTotal = val(r, "devicesTotal");
  const devUp    = val(r, "devicesUp");
  const health   = val(r, "siteHealth");
  const wanUp    = val(r, "wanUp");
  const wanTotal = val(r, "wanTotal");
  const bfdUp    = val(r, "bfdUp");
  const bfdTotal = val(r, "bfdTotal");
  const ompUp    = val(r, "ompUp");
  const ompTotal = val(r, "ompTotal");
  const bgpUp    = val(r, "bgpUp");
  const bgpTotal = val(r, "bgpTotal");

  // Prefer the precomputed site_health_percent; fall back to the ratio.
  let reach = health;
  if (reach == null && devTotal) reach = 100 * (devUp || 0) / devTotal;

  return {
    reachability: rec(round1(reach), {
      unit: "%", up: roundInt(devUp), total: roundInt(devTotal)
    }),
    sdwan_devices:       rec(roundInt(devTotal)),
    routers:             rec(roundInt(val(r, "routers"))),
    sites:               rec(roundInt(val(r, "siteCount"))),
    unreachable:         rec(roundInt(downFrom(devTotal, devUp))),
    wan_links_up:        rec(roundInt(wanUp), { total: roundInt(wanTotal) }),
    wan_availability:    rec(wanTotal ? round1(100 * (wanUp || 0) / wanTotal) : null, { unit: "%" }),
    wan_utilization:     rec(round1(val(r, "wanUtilAvg")), { unit: "%", max: round1(val(r, "wanUtilMax")) }),
    wan_capacity:        rec(val(r, "wanCapacity"), { unit: "bps" }),
    bfd_up:              rec(roundInt(bfdUp), { total: roundInt(bfdTotal) }),
    bfd_down:            rec(roundInt(downFrom(bfdTotal, bfdUp)), { total: roundInt(bfdTotal) }),
    omp_up:              rec(roundInt(ompUp), { total: roundInt(ompTotal) }),
    omp_down:            rec(roundInt(downFrom(ompTotal, ompUp)), { total: roundInt(ompTotal) }),
    bgp_established:     rec(roundInt(bgpUp), { total: roundInt(bgpTotal) }),
    bgp_down:            rec(roundInt(downFrom(bgpTotal, bgpUp)), { total: roundInt(bgpTotal) }),
    control_connections: rec(roundInt(val(r, "controlUp"))),
    latency_ms:          rec(round1(val(r, "latency")), { unit: "ms" }),
    jitter_ms:           rec(round1(val(r, "jitter")), { unit: "ms" }),
    loss_percent:        rec(round1(val(r, "loss")), { unit: "%" }),
    scrape_age_seconds:  rec(roundInt(val(r, "scrapeAge")), { unit: "s" })
  };
}

function alignSeries(rx, tx) {
  const times = Array.from(new Set(
    (rx || []).map(function (p) { return p[0]; })
      .concat((tx || []).map(function (p) { return p[0]; }))
  )).sort(function (a, b) { return a - b; });
  const rxM = new Map(rx || []), txM = new Map(tx || []);
  return {
    times: times,
    ingress: times.map(function (t) { return rxM.has(t) ? rxM.get(t) : null; }),
    egress:  times.map(function (t) { return txM.has(t) ? txM.get(t) : null; })
  };
}

/* ------------------------------------------------------- region breakdown */

async function regionBreakdown(prom, trace) {
  const out = {};
  await Promise.all(REGIONS.map(async function (r) {
    const s = CAT.sel("", r);
    const res = await resolveMany(prom, {
      devicesTotal: CAT.INSTANT.devicesTotal,
      devicesUp:    CAT.INSTANT.devicesUp,
      siteHealth:   CAT.INSTANT.siteHealth,
      siteCount:    CAT.INSTANT.siteCount,
      wanUp:        CAT.INSTANT.wanUp,
      wanTotal:     CAT.INSTANT.wanTotal,
      wanUtilAvg:   CAT.INSTANT.wanUtilAvg,
      latency:      CAT.INSTANT.latency,
      loss:         CAT.INSTANT.loss,
      bfdUp:        CAT.INSTANT.bfdUp,
      bfdTotal:     CAT.INSTANT.bfdTotal
    }, s, trace, 5);

    const devTotal = val(res, "devicesTotal");
    const devUp    = val(res, "devicesUp");
    const wanUp    = val(res, "wanUp");
    const wanTotal = val(res, "wanTotal");
    let avail = val(res, "siteHealth");
    if (avail == null && devTotal) avail = 100 * (devUp || 0) / devTotal;

    out[r] = {
      region: r,
      sites: roundInt(val(res, "siteCount")),
      devices: roundInt(devTotal),
      devices_up: roundInt(devUp),
      availability: round1(avail),
      bfd_up: roundInt(val(res, "bfdUp")),
      bfd_total: roundInt(val(res, "bfdTotal")),
      wan_links_up: roundInt(wanUp),
      wan_links_total: roundInt(wanTotal),
      wan_availability: wanTotal ? round1(100 * (wanUp || 0) / wanTotal) : null,
      wan_utilization: round1(val(res, "wanUtilAvg")),
      latency_ms: round1(val(res, "latency")),
      loss_percent: round1(val(res, "loss")),
      has_data: devTotal != null || wanTotal != null
    };
  }));
  return out;
}

/* -------------------------------------------------------------- DC rollup */

const DC_PRIORITY = process.env.DC_PRIORITY || "P1";
const DC_SITE_IDS = String(process.env.DC_SITE_IDS || "")
  .split(",").map(function (x) { return x.trim(); }).filter(Boolean);

function dcSelector(region) {
  const parts = [];
  if (DC_SITE_IDS.length) parts.push('site_id=~"' + DC_SITE_IDS.map(CAT.esc).join("|") + '"');
  else parts.push('priority="' + CAT.esc(DC_PRIORITY) + '"');
  if (region) parts.push('region="' + CAT.esc(region) + '"');
  return "{" + parts.join(",") + "}";
}

async function dcRollup(prom, region, trace) {
  const s = dcSelector(region);
  const keys = Object.keys(CAT.PER_SITE);
  const resolved = {};
  await Promise.all(keys.map(async function (k) {
    resolved[k] = await resolveSeries(prom, CAT.PER_SITE[k](s), trace, "dc." + k);
  }));

  const bySite = {};
  function touch(metric) {
    const sid = (metric && metric.site_id) || "unknown";
    if (!bySite[sid]) {
      bySite[sid] = {
        site_id: sid,
        region: (metric && metric.region) || null,
        country: (metric && metric.country) || null,
        priority: (metric && metric.priority) || null,
        devices: null, devices_up: null, health: null,
        wan_links_up: null, wan_links_total: null,
        bfd_up: null, bfd_total: null,
        latency_ms: null, loss_percent: null, uptime_seconds: null
      };
    }
    const row = bySite[sid];
    if (metric) {
      row.region = row.region || metric.region || null;
      row.country = row.country || metric.country || null;
      row.priority = row.priority || metric.priority || null;
    }
    return row;
  }

  const FIELD = {
    total: "devices", up: "devices_up", health: "health",
    wanUp: "wan_links_up", wanTotal: "wan_links_total",
    bfdUp: "bfd_up", bfdTotal: "bfd_total",
    latency: "latency_ms", loss: "loss_percent", uptime: "uptime_seconds"
  };
  keys.forEach(function (k) {
    (resolved[k].samples || []).forEach(function (sm) {
      const row = touch(sm.metric);
      const f = FIELD[k];
      // Several series can map to one site (per-device rows); sum counts,
      // take the minimum for uptime, and average-free single values for the rest.
      if (f === "uptime_seconds") {
        row[f] = row[f] == null ? sm.value : Math.min(row[f], sm.value);
      } else if (f === "devices" || f === "devices_up" ||
                 f === "wan_links_up" || f === "wan_links_total" ||
                 f === "bfd_up" || f === "bfd_total") {
        row[f] = (row[f] || 0) + sm.value;
      } else {
        row[f] = sm.value;
      }
    });
  });

  const sites = Object.keys(bySite).map(function (k) { return bySite[k]; })
    .map(function (r) {
      let avail = r.health;
      if (avail == null && r.devices) avail = 100 * (r.devices_up || 0) / r.devices;
      const wanAvail = r.wan_links_total
        ? round1(100 * (r.wan_links_up || 0) / r.wan_links_total) : null;
      return {
        site_id: r.site_id, region: r.region, country: r.country, priority: r.priority,
        devices: roundInt(r.devices), devices_up: roundInt(r.devices_up),
        availability: round1(avail),
        wan_links_up: roundInt(r.wan_links_up),
        wan_links_total: roundInt(r.wan_links_total),
        wan_availability: wanAvail,
        bfd_up: roundInt(r.bfd_up), bfd_total: roundInt(r.bfd_total),
        latency_ms: round1(r.latency_ms), loss_percent: round1(r.loss_percent),
        uptime_seconds: roundInt(r.uptime_seconds),
        uptime_days: r.uptime_seconds != null ? round1(r.uptime_seconds / 86400) : null,
        status: avail == null ? "UNKNOWN"
              : avail >= 99 ? "HEALTHY"
              : avail >= 90 ? "DEGRADED" : "CRITICAL"
      };
    })
    .sort(function (a, b) {
      const av = a.availability == null ? 999 : a.availability;
      const bv = b.availability == null ? 999 : b.availability;
      return av - bv || String(a.site_id).localeCompare(String(b.site_id));
    });

  const withAvail = sites.filter(function (x) { return x.availability != null; });
  const sources = {};
  keys.forEach(function (k) { sources[k] = { expr: resolved[k].expr, rung: resolved[k].rung }; });

  return {
    definition: DC_SITE_IDS.length
      ? { by: "site_id", site_ids: DC_SITE_IDS }
      : { by: "priority", priority: DC_PRIORITY },
    count: sites.length,
    healthy:  sites.filter(function (x) { return x.status === "HEALTHY"; }).length,
    degraded: sites.filter(function (x) { return x.status === "DEGRADED"; }).length,
    critical: sites.filter(function (x) { return x.status === "CRITICAL"; }).length,
    availability: withAvail.length
      ? round1(withAvail.reduce(function (a, x) { return a + x.availability; }, 0) / withAvail.length)
      : null,
    sources: sources,
    sites: sites
  };
}

/* -------------------------------------------------------------- main call */

async function getNetworkGlobal(siteId, client, rangeKey, opts) {
  opts = opts || {};
  const range = resolveRange(rangeKey);
  const win = THROUGHPUT_RANGES[range];
  const region = normalizeRegion(opts.region);
  const trace = opts.trace ? [] : null;

  let sid = "";
  if (siteId) {
    const check = validateSiteId(siteId);
    if (!check.ok) {
      return {
        error: check.error, scope: "invalid",
        site_id: extractSiteId(siteId) || siteId,
        region: region || null, range: range, range_label: win.label,
        kpis: {}, throughput: { times: [], ingress: [], egress: [] }
      };
    }
    sid = check.siteId;
  }

  const prom = client || new PrometheusClient();
  const s = CAT.sel(sid, region);
  const now = Math.floor(Date.now() / 1000);
  const start = now - win.seconds;

  let resolved;
  try {
    resolved = await resolveMany(prom, CAT.INSTANT, s, trace, 6);
  } catch (err) {
    return {
      prometheus_unavailable: true,
      error: "Monitoring data temporarily unavailable",
      scope: sid ? "site" : (region ? "region" : "global"),
      site_id: sid || null, region: region || null,
      range: range, range_label: win.label,
      last_updated: new Date().toISOString(),
      kpis: {}, throughput: { times: [], ingress: [], egress: [] }
    };
  }

  const pair = await Promise.all([
    resolveRangeSeries(prom, CAT.RANGE.rx(s), start, now, win.step, trace, "throughput.rx"),
    resolveRangeSeries(prom, CAT.RANGE.tx(s), start, now, win.step, trace, "throughput.tx")
  ]);

  const extras = {};
  if (opts.withRegions) {
    try { extras.regions = await regionBreakdown(prom, trace); } catch (e) { extras.regions = {}; }
  }
  if (opts.withDc) {
    try { extras.datacenters = await dcRollup(prom, region, trace); }
    catch (e) { extras.datacenters = { count: 0, sites: [], error: String(e.message || e) }; }
  }
  if (opts.withAvailability) {
    try {
      const av = await resolveRangeSeries(prom, CAT.RANGE.availability(s),
        start, now, win.step, trace, "availability");
      extras.availability_series = { times: av.points.map(function (p) { return p[0]; }),
                                     values: av.points.map(function (p) { return p[1]; }),
                                     expr: av.expr };
    } catch (e) { extras.availability_series = null; }
  }

  // "No data at all" means every ladder came back empty, not that one did.
  const names = Object.keys(resolved);
  const resolvedCount = names.filter(function (k) { return resolved[k].rung >= 0; }).length;
  const noData = resolvedCount === 0 && !pair[0].points.length && !pair[1].points.length;

  const sources = {};
  names.forEach(function (k) { sources[k] = { expr: resolved[k].expr, rung: resolved[k].rung }; });
  sources["throughput.rx"] = { expr: pair[0].expr, rung: pair[0].rung };
  sources["throughput.tx"] = { expr: pair[1].expr, rung: pair[1].rung };

  const lastUpdated = new Date().toISOString();
  const payload = {
    scope: sid ? "site" : (region ? "region" : "global"),
    site_id: sid || null,
    region: region || null,
    regions_available: REGIONS,
    range: range,
    range_label: win.label,
    ranges_available: Object.keys(THROUGHPUT_RANGES).map(function (k) {
      return { key: k, label: THROUGHPUT_RANGES[k].label };
    }),
    last_updated: lastUpdated,
    scraped_at: lastUpdated,
    prometheus_unavailable: noData,
    prometheus_base: prom.baseUrl || null,
    metrics_resolved: resolvedCount,
    metrics_total: names.length,
    kpis: buildKpis(resolved),
    throughput: alignSeries(pair[0].points, pair[1].points),
    throughput_source: { rx: pair[0].expr, tx: pair[1].expr },
    sources: sources
  };

  Object.assign(payload, extras);
  if (trace) payload.diagnostics = trace;
  return payload;
}

/* --------------------------------------------------------------- diag API */

async function getNetworkDiagnostics(client, region) {
  const prom = client || new PrometheusClient();
  const reg = normalizeRegion(region);
  const s = reg ? '{region="' + CAT.esc(reg) + '"}' : "";

  const spec = {};
  CAT.PROBES.forEach(function (p) {
    spec[p[0]] = p[1].indexOf("%s") >= 0 ? p[1].replace("%s", s) : p[1];
  });

  let q;
  try {
    q = await prom.queryMany(spec, 6);
  } catch (err) {
    return {
      prometheus_unavailable: true,
      prometheus_base: prom.baseUrl || null,
      error: String(err.message || err)
    };
  }

  const metrics = {};
  const present = [];
  const missing = [];
  Object.keys(spec).forEach(function (name) {
    const e = q[name];
    const c = e && e.ok ? scalarFrom(e.result) : null;
    const ok = c != null && c > 0;
    metrics[name] = { expr: spec[name], present: ok, series: c == null ? 0 : Math.round(c),
                      error: e && e.ok ? null : (e && e.error) || null };
    (ok ? present : missing).push(name);
  });

  function any(prefix) {
    return present.some(function (n) { return n.indexOf(prefix) === 0; });
  }

  const hints = [];
  const unified = any("UNIFIED");
  const vmanage = any("VMANAGE");
  const meraki  = any("MERAKI");

  if (!unified && (vmanage || meraki)) {
    hints.push(
      "The unified recording rules are producing NO series, but raw exporter metrics " +
      "are present. This is the single most likely cause of blank dashboards: the CXO " +
      "pages and complete-observability.json both read the unified namespace. Confirm " +
      "prometheus.yml has rule_files: /etc/prometheus/rules/*.yml and that " +
      "unified-rules.yml is mounted there, then check /rules in the Prometheus UI for " +
      "rule evaluation errors."
    );
  }
  if (!unified && !vmanage && !meraki) {
    hints.push("No series from any layer. Prometheus is reachable but has no data for " +
               "this scope — check the scrape targets page.");
  }
  if (unified && !vmanage && meraki) {
    hints.push("This estate is Meraki-only in Prometheus: no vmanage_* series exist. " +
               "Overlay panels (BFD, OMP, BGP) are vManage-derived and will stay empty " +
               "by design; that is a data-coverage fact, not a page fault.");
  }
  if (unified && vmanage && !meraki) {
    hints.push("No meraki_* series. Meraki-derived WAN panels will stay empty.");
  }
  if (metrics["ABSENT meraki_uplink_util_percent"] &&
      !metrics["ABSENT meraki_uplink_util_percent"].present) {
    hints.push(
      "Separate finding, unrelated to the CXO pages: meraki_uplink_util_percent is " +
      "queried by all four carrier-* Grafana dashboards and by generate_dashboards.py, " +
      "but no exporter emits it and no recording rule defines it. Those Grafana panels " +
      "are dead. The working equivalent is wan_link_utilization_percent."
    );
  }
  if (reg && !present.length) {
    hints.push('No series carry region="' + reg + '". Check that sites.json is mounted ' +
               "into the exporters — without it every site resolves to the default region.");
  }

  return {
    prometheus_base: prom.baseUrl || null,
    region: reg || null,
    checked_at: new Date().toISOString(),
    total: Object.keys(spec).length,
    present: present.length,
    layers: { unified: unified, vmanage: vmanage, meraki: meraki },
    missing: missing,
    hints: hints,
    metrics: metrics
  };
}

module.exports = {
  getNetworkGlobal,
  getNetworkDiagnostics,
  regionBreakdown,
  dcRollup,
  buildKpis,
  alignSeries,
  normalizeRegion,
  resolveScalar,
  resolveMany,
  REGIONS,
  THROUGHPUT_RANGES,
  resolveRange
};
