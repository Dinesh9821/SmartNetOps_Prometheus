"use strict";

const {
  PrometheusClient,
  samples,
  scalarFrom,
  latestTsFromResults,
  isoFromUnix
} = require("./prometheusClient");
const { extractSiteId, validateSiteId, escapeLabel } = require("./monitoringService");

function m(name, siteId) {
  return siteId ? `${name}{site_id="${escapeLabel(siteId)}"}` : name;
}

function rec(value, extra) {
  const available = value != null && Number.isFinite(value);
  return Object.assign({ value: available ? value : null, available: available }, extra || {});
}

function firstScalar(q, names) {
  for (let i = 0; i < names.length; i++) {
    const n = names[i];
    if (!q[n] || !q[n].ok) continue;
    const v = scalarFrom(q[n].result);
    if (v != null) return v;
  }
  return null;
}

function downFrom(total, up) {
  if (total == null) return null;
  return Math.max(total - (up || 0), 0);
}

function roundInt(v) {
  return v == null || !Number.isFinite(v) ? null : Math.round(v);
}

const THROUGHPUT_RANGES = {
  "5m": { seconds: 5 * 60, step: 10, label: "Last 5 minutes" },
  "15m": { seconds: 15 * 60, step: 15, label: "Last 15 minutes" },
  "1h": { seconds: 60 * 60, step: 30, label: "Last 1 hour" },
  "6h": { seconds: 6 * 60 * 60, step: 120, label: "Last 6 hours" },
  "24h": { seconds: 24 * 60 * 60, step: 300, label: "Last 24 hours" },
  "7d": { seconds: 7 * 24 * 60 * 60, step: 1800, label: "Last 7 days" },
  "30d": { seconds: 30 * 24 * 60 * 60, step: 3600, label: "Last 30 days" },
  "90d": { seconds: 90 * 24 * 60 * 60, step: 10800, label: "Last 90 days" },
  "6m": { seconds: 182 * 24 * 60 * 60, step: 21600, label: "Last 6 months" },
  "1y": { seconds: 365 * 24 * 60 * 60, step: 86400, label: "Last 1 year" }
};

function resolveRange(rangeKey) {
  return THROUGHPUT_RANGES[rangeKey] ? rangeKey : "1h";
}

function networkGlobalQueries(siteId) {
  siteId = siteId || "";
  return {
    reachable: m("vmanage_device_reachable", siteId),
    ompUp: `sum(${m("vmanage_omp_peers_up", siteId)})`,
    ompTotal: `sum(${m("vmanage_omp_peers_total", siteId)})`,
    bfdUp: `sum(${m("vmanage_bfd_sessions_up", siteId)})`,
    bfdTotal: `sum(${m("vmanage_bfd_sessions_total", siteId)})`,
    bgpUp: `sum(${m("vmanage_bgp_neighbors_up", siteId)})`,
    bgpTotal: `sum(${m("vmanage_bgp_neighbors_total", siteId)})`,
    controlUp: `sum(${m("vmanage_control_connections_up", siteId)})`
  };
}

function hostOf(metric) {
  metric = metric || {};
  return metric.hostname || metric.device || metric.system_ip || "";
}

function isRouter(metric) {
  const t = String((metric && (metric.device_role || metric.device_type || metric.role)) || "").toUpperCase();
  const host = hostOf(metric);
  return t.includes("ROUTER") || t.includes("VEDGE") || t.includes("CEDGE") ||
    t.includes("EDGE") || /RTR|VEDGE|CEDGE|-CE/i.test(host);
}

function buildKpis(q) {
  const devices = samples(q.reachable && q.reachable.result);
  const reachable = devices.filter((s) => s.value >= 1).length;
  const unreachable = devices.filter((s) => s.value < 1).length;
  const totalDev = devices.length;
  const hosts = new Set(devices.map((s) => hostOf(s.metric)).filter(Boolean));
  const routerHosts = new Set(
    devices.filter((s) => isRouter(s.metric)).map((s) => hostOf(s.metric)).filter(Boolean)
  );
  const sdwan = hosts.size || totalDev;
  const routers = routerHosts.size || sdwan;
  const reachPct = totalDev ? Number((100 * reachable / totalDev).toFixed(1)) : null;

  const ompUp = firstScalar(q, ["ompUp"]);
  const ompTotal = firstScalar(q, ["ompTotal"]);
  const bfdUp = firstScalar(q, ["bfdUp"]);
  const bfdTotal = firstScalar(q, ["bfdTotal"]);
  const bgpUp = firstScalar(q, ["bgpUp"]);
  const bgpTotal = firstScalar(q, ["bgpTotal"]);
  const control = firstScalar(q, ["controlUp"]);

  return {
    reachability: rec(reachPct, {
      unit: "%",
      up: totalDev ? reachable : null,
      total: totalDev || null
    }),
    omp_up: rec(roundInt(ompUp), { total: roundInt(ompTotal) }),
    bfd_up: rec(roundInt(bfdUp), { total: roundInt(bfdTotal) }),
    bgp_established: rec(roundInt(bgpUp), { total: roundInt(bgpTotal) }),
    routers: rec(roundInt(routers) || null),
    sdwan_devices: rec(roundInt(sdwan) || null),
    unreachable: rec(totalDev ? unreachable : null),
    bfd_down: rec(roundInt(downFrom(bfdTotal, bfdUp)), { total: roundInt(bfdTotal) }),
    bgp_down: rec(roundInt(downFrom(bgpTotal, bgpUp)), { total: roundInt(bgpTotal) }),
    omp_down: rec(roundInt(downFrom(ompTotal, ompUp)), { total: roundInt(ompTotal) }),
    control_connections: rec(roundInt(control))
  };
}

function rangeValues(result) {
  if (!result || !result.length) return [];
  const buckets = {};
  result.forEach((s) => {
    (s.values || []).forEach((pair) => {
      const n = Number(pair && pair[1]);
      if (!Number.isFinite(n)) return;
      const t = Number(pair[0]);
      buckets[t] = (buckets[t] || 0) + n;
    });
  });
  return Object.keys(buckets).sort((a, b) => Number(a) - Number(b)).map((t) => [Number(t), buckets[t]]);
}

function alignSeries(rx, tx) {
  const times = Array.from(new Set(
    (rx || []).map((p) => p[0]).concat((tx || []).map((p) => p[0]))
  )).sort((a, b) => a - b);
  const rxM = new Map(rx || []);
  const txM = new Map(tx || []);
  return {
    times: times,
    ingress: times.map((t) => (rxM.has(t) ? rxM.get(t) : null)),
    egress: times.map((t) => (txM.has(t) ? txM.get(t) : null))
  };
}

async function getNetworkGlobal(siteId, client, rangeKey) {
  const range = resolveRange(rangeKey);
  const window = THROUGHPUT_RANGES[range];
  let sid = "";
  if (siteId) {
    const check = validateSiteId(siteId);
    if (!check.ok) {
      return {
        error: check.error,
        scope: "invalid",
        site_id: extractSiteId(siteId) || siteId,
        range: range,
        range_label: window.label,
        kpis: {},
        throughput: { times: [], ingress: [], egress: [] }
      };
    }
    sid = check.siteId;
  }

  const prom = client || new PrometheusClient();
  const now = Math.floor(Date.now() / 1000);
  let q;
  try {
    q = await prom.queryMany(networkGlobalQueries(sid), 8);
  } catch (err) {
    return {
      prometheus_unavailable: true,
      error: "Monitoring data temporarily unavailable",
      scope: sid ? "site" : "global",
      site_id: sid || null,
      range: range,
      range_label: window.label,
      last_updated: new Date().toISOString(),
      kpis: {},
      throughput: { times: [], ingress: [], egress: [] }
    };
  }

  const series = { rx: [], tx: [] };
  await Promise.all([
    ["rx", `sum(${m("wan_link_rx_bits_per_second", sid)})`],
    ["tx", `sum(${m("wan_link_tx_bits_per_second", sid)})`]
  ].map(async ([name, expr]) => {
    try {
      series[name] = rangeValues(await prom.queryRange(expr, now - window.seconds, now, window.step));
    } catch (err) {
      series[name] = [];
    }
  }));

  const qvals = Object.values(q);
  const allFailed = qvals.length && qvals.every((v) => !v.ok);
  const lastUpdated = new Date().toISOString();
  return {
    scope: sid ? "site" : "global",
    site_id: sid || null,
    range: range,
    range_label: window.label,
    last_updated: lastUpdated,
    scraped_at: isoFromUnix(latestTsFromResults(q)) || lastUpdated,
    prometheus_unavailable: !!allFailed,
    kpis: buildKpis(q),
    throughput: alignSeries(series.rx, series.tx)
  };
}

module.exports = {
  getNetworkGlobal,
  networkGlobalQueries,
  buildKpis,
  alignSeries,
  THROUGHPUT_RANGES,
  resolveRange
};
