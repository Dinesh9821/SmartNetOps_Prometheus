"use strict";

const {
  PrometheusClient,
  samples,
  scalarFrom,
  avgFrom,
  maxFrom,
  latestTsFromResults,
  isoFromUnix
} = require("./prometheusClient");
const { extractSiteId, validateSiteId, escapeLabel } = require("./monitoringService");

function sel(siteId) {
  return siteId ? `{site_id="${escapeLabel(siteId)}"}` : "";
}

function m(name, siteId) {
  return siteId ? `${name}{site_id="${escapeLabel(siteId)}"}` : name;
}

function num(v, digits) {
  if (v == null || !Number.isFinite(v)) return null;
  if (digits == null) return v;
  return Number(v.toFixed(digits));
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

function firstAvg(q, names) {
  for (let i = 0; i < names.length; i++) {
    const n = names[i];
    if (!q[n] || !q[n].ok) continue;
    const v = avgFrom(q[n].result);
    if (v != null) return v;
  }
  return null;
}

function rangeValues(result) {
  if (!result || !result.length) return [];
  const buckets = {};
  result.forEach((s) => {
    (s.values || []).forEach(([ts, v]) => {
      const n = Number(v);
      if (!Number.isFinite(n)) return;
      const t = Number(ts);
      buckets[t] = (buckets[t] || 0) + n;
    });
  });
  return Object.keys(buckets).sort((a, b) => a - b).map((t) => [Number(t), buckets[t]]);
}

function scaleToPct(points) {
  if (!points.length) return [];
  const max = Math.max.apply(null, points.map((p) => Math.abs(p[1])).concat([1]));
  return points.map((p) => num(100 * p[1] / max, 2));
}

function instantQueries(siteId) {
  const S = sel(siteId);
  return {
    health: `avg(${m("site_health_percent", siteId)})`,
    devicesTotalAll: `sum(${m("site_devices_total:all", siteId)})`,
    devicesUpAll: `sum(${m("site_devices_up:all", siteId)})`,
    deviceInfo: `device_info${S}`,
    clients: `sum(${m("meraki_switch_client_count", siteId)})`,
    latencyRec: `quantile(0.95, ${m("wan_link_latency_milliseconds", siteId)})`,
    latencyVmanage: `quantile(0.95, ${m("vmanage_wan_link_latency_ms", siteId)})`,
    latencyBfd: `quantile(0.95, ${m("vmanage_bfd_session_latency_ms", siteId)})`,
    latencyMeraki: siteId
      ? `quantile(0.95, max by (serial, uplink) (meraki_uplink_latency_milliseconds) and on (serial) group_left () (max by (serial) (meraki_device_up${S})))`
      : "quantile(0.95, meraki_uplink_latency_milliseconds)",
    wanUp: `wan_link_up${S}`,
    wanUtil: `avg(${m("wan_link_utilization_percent", siteId)})`,
    cpuLoad: `avg(${m("meraki_device_cpu_load5", siteId)})`,
    cpuCount: `avg(${m("meraki_device_cpu_count", siteId)})`,
    memory: `avg(${m("meraki_device_memory_used_percent", siteId)})`,
    alerts: siteId
      ? `ALERTS{alertstate="firing",site_id="${escapeLabel(siteId)}"}`
      : "ALERTS{alertstate=\"firing\"}",
    byRegion: `count by (region) (device_info${S})`,
    byRegionDown: `count by (region) (device_info${S} == 0)`,
    bySource: `count by (source) (device_info${S})`
  };
}

function buildKpis(q) {
  const total = firstScalar(q, ["devicesTotalAll"]) || samples(q.deviceInfo && q.deviceInfo.result).length;
  const up = firstScalar(q, ["devicesUpAll"]);
  let health = firstAvg(q, ["health"]);
  if (health == null && total) {
    const online = samples(q.deviceInfo && q.deviceInfo.result).filter((s) => s.value >= 1).length;
    health = 100 * online / total;
  }
  const latency = firstAvg(q, ["latencyRec", "latencyVmanage", "latencyBfd", "latencyMeraki"]);
  const clients = firstScalar(q, ["clients"]);
  return {
    devices: { value: total || 0, available: total != null && total > 0 },
    uptime: { value: num(health, 2), unit: "%", available: health != null },
    clients: { value: clients, available: clients != null },
    latency: { value: num(latency, 1), unit: "ms", available: latency != null }
  };
}

function buildResources(q) {
  const mem = firstAvg(q, ["memory"]);
  const util = firstAvg(q, ["wanUtil"]);
  const load = firstAvg(q, ["cpuLoad"]);
  const cores = firstAvg(q, ["cpuCount"]);
  let cpu = null;
  if (load != null && cores && cores > 0) cpu = 100 * (load / cores);
  else if (load != null) cpu = Math.min(100, load * 100 / 4);
  return {
    cpu: { value: num(cpu, 1), available: cpu != null, label: "CPU" },
    memory: { value: num(mem, 1), available: mem != null, label: "Memory" },
    disk: { value: null, available: false, label: "Disk", reason: "No disk Prometheus metric" },
    network: { value: num(util, 1), available: util != null, label: "Network" }
  };
}

function buildEvents(q, kpis) {
  const events = [];
  samples(q.alerts && q.alerts.result).forEach((s) => {
    const name = s.metric.alertname || s.metric.alert || "Alert";
    const site = s.metric.site_id || "";
    events.push({
      s: String(s.metric.severity || "").toLowerCase() === "warning" ? "warn" : "crit",
      t: name,
      m: [site, s.metric.instance, s.metric.device].filter(Boolean).join(" · ") || "Prometheus ALERTS",
      ts: isoFromUnix(s.ts)
    });
  });
  samples(q.wanUp && q.wanUp.result).filter((s) => s.value === 0).slice(0, 8).forEach((s) => {
    events.push({
      s: "crit",
      t: "WAN link down",
      m: [s.metric.site_id, s.metric.device, s.metric.link].filter(Boolean).join(" · "),
      ts: isoFromUnix(s.ts)
    });
  });
  samples(q.deviceInfo && q.deviceInfo.result).filter((s) => s.value === 0).slice(0, 8).forEach((s) => {
    events.push({
      s: "crit",
      t: "Device down",
      m: [s.metric.site_id, s.metric.device, s.metric.source].filter(Boolean).join(" · "),
      ts: isoFromUnix(s.ts)
    });
  });
  samples(q.deviceInfo && q.deviceInfo.result).filter((s) => s.value > 0 && s.value < 1).slice(0, 6).forEach((s) => {
    events.push({
      s: "warn",
      t: "Device alerting",
      m: [s.metric.site_id, s.metric.device].filter(Boolean).join(" · "),
      ts: isoFromUnix(s.ts)
    });
  });
  if (kpis.latency.available && kpis.latency.value > 80) {
    events.push({ s: "warn", t: "Latency above target", m: "p95 " + kpis.latency.value + " ms across WAN links" });
  }
  if (!events.length && kpis.uptime.available && kpis.uptime.value >= 99) {
    events.push({ s: "ok", t: "Fleet reporting healthy", m: "No firing WAN or device faults in this scope" });
  }
  return events.slice(0, 12);
}

function buildInsights(events, kpis, resources) {
  const out = [];
  events.filter((e) => e.s === "crit").slice(0, 2).forEach((e) => {
    out.push({ t: e.t + " — " + e.m, a: "Open Monitoring" });
  });
  if (resources.network.available && resources.network.value >= 80) {
    out.push({ t: "WAN utilization is " + resources.network.value + "% of capacity in this scope.", a: "Review WAN" });
  }
  if (kpis.uptime.available && kpis.uptime.value < 99) {
    out.push({ t: "Reachability is " + kpis.uptime.value + "% (devices up / devices total).", a: "Open Monitoring" });
  }
  if (!out.length && kpis.devices.available) {
    out.push({ t: kpis.devices.value + " devices in scope. No critical Prometheus conditions in this snapshot.", a: "Refresh" });
  }
  return out.slice(0, 3);
}

function buildTopology(q, siteId) {
  const tint = (v) => (v === 0 ? "crit" : (v > 0 && v < 1 ? "warn" : "ok"));
  if (siteId) {
    const devices = samples(q.deviceInfo && q.deviceInfo.result).slice(0, 10);
    const nodes = [{ id: "site", x: 260, y: 105, r: 20, label: siteId.slice(0, 12), st: "ok" }];
    const links = [];
    devices.forEach((s, i) => {
      const id = "d" + i;
      const angle = (Math.PI * 2 * i) / Math.max(devices.length, 1) - Math.PI / 2;
      nodes.push({
        id,
        x: 260 + Math.cos(angle) * 150,
        y: 105 + Math.sin(angle) * 72,
        r: 13,
        label: String(s.metric.device || s.metric.ident || "dev").slice(0, 10),
        st: tint(s.value)
      });
      links.push(["site", id]);
    });
    const wanDown = samples(q.wanUp && q.wanUp.result).filter((s) => s.value === 0).length;
    const wanTotal = samples(q.wanUp && q.wanUp.result).length;
    nodes.push({
      id: "wan", x: 520, y: 105, r: 13, label: "WAN",
      st: wanTotal && wanDown === wanTotal ? "crit" : (wanDown ? "warn" : "ok")
    });
    links.push(["site", "wan"]);
    return { nodes, links, critical: nodes.filter((n) => n.st === "crit").length };
  }

  const regions = samples(q.byRegion && q.byRegion.result);
  const downMap = {};
  samples(q.byRegionDown && q.byRegionDown.result).forEach((s) => {
    downMap[s.metric.region || "unknown"] = s.value;
  });
  const nodes = [{ id: "fleet", x: 260, y: 105, r: 22, label: "Fleet", st: "ok" }];
  const links = [];
  const layout = [
    { x: 90, y: 48 }, { x: 90, y: 165 }, { x: 430, y: 48 }, { x: 430, y: 165 }
  ];
  regions.slice(0, 4).forEach((s, i) => {
    const id = "r" + i;
    const name = s.metric.region || "region";
    const down = downMap[name] || 0;
    nodes.push({
      id,
      x: layout[i].x,
      y: layout[i].y,
      r: 15,
      label: String(name).slice(0, 8),
      st: down > 0 ? (down >= s.value ? "crit" : "warn") : "ok"
    });
    links.push(["fleet", id]);
  });
  const sources = samples(q.bySource && q.bySource.result);
  sources.slice(0, 2).forEach((s, i) => {
    const id = "src" + i;
    nodes.push({
      id,
      x: 520,
      y: i === 0 ? 55 : 155,
      r: 12,
      label: String(s.metric.source || "src").slice(0, 8),
      st: "ok"
    });
    links.push(["fleet", id]);
  });
  if (regions.length === 0 && sources.length === 0) {
    nodes.push({ id: "empty", x: 430, y: 105, r: 12, label: "No data", st: "warn" });
    links.push(["fleet", "empty"]);
  }
  return { nodes, links, critical: nodes.filter((n) => n.st === "crit").length };
}

function buildHeatmap(points) {
  const cells = [];
  for (let d = 0; d < 7; d++) {
    cells[d] = [];
    for (let h = 0; h < 24; h++) cells[d][h] = 0;
  }
  let max = 0;
  points.forEach(([ts, v]) => {
    const dt = new Date(ts * 1000);
    const d = dt.getUTCDay();
    const h = dt.getUTCHours();
    cells[d][h] += v;
    if (cells[d][h] > max) max = cells[d][h];
  });
  if (max <= 0) max = 1;
  return cells.map((row) => row.map((v) => num(v / max, 3)));
}

async function getDashboard(siteId, client) {
  const check = siteId ? validateSiteId(siteId) : { ok: true, siteId: "" };
  if (siteId && !check.ok) {
    return { error: check.error, scope: "invalid", kpis: {}, events: [] };
  }
  const sid = check.siteId || "";
  const prom = client || new PrometheusClient();
  const now = Math.floor(Date.now() / 1000);

  let q;
  try {
    q = await prom.queryMany(instantQueries(sid), 8);
  } catch (err) {
    return {
      scope: sid ? "site" : "global",
      site_id: sid || null,
      prometheus_unavailable: true,
      error: "Monitoring data temporarily unavailable",
      last_updated: new Date().toISOString(),
      scraped_at: null
    };
  }

  const kpis = buildKpis(q);
  const resources = buildResources(q);
  const events = buildEvents(q, kpis);
  const topology = buildTopology(q, sid);
  const insights = buildInsights(events, kpis, resources);

  const S = sel(sid);
  const rangeJobs = {
    rx: { expr: `avg(${m("wan_link_rx_bits_per_second", sid)})`, start: now - 3600, step: 60 },
    tx: { expr: `avg(${m("wan_link_tx_bits_per_second", sid)})`, start: now - 3600, step: 60 },
    util: { expr: `avg(${m("wan_link_utilization_percent", sid)})`, start: now - 3600, step: 60 },
    health: { expr: `avg(${m("site_health_percent", sid)})`, start: now - 86400, step: 3600 },
    devices: { expr: `count(device_info${S})`, start: now - 86400, step: 3600 },
    clients: { expr: `sum(${m("meraki_switch_client_count", sid)})`, start: now - 86400, step: 3600 },
    latency: { expr: `avg(${m("wan_link_latency_milliseconds", sid)}) or avg(${m("vmanage_wan_link_latency_ms", sid)}) or avg(vmanage_bfd_session_latency_ms${S})`, start: now - 86400, step: 3600 },
    load: { expr: `sum(${m("wan_link_bits_per_second", sid)}) or sum(${m("wan_link_rx_bits_per_second", sid)})`, start: now - 7 * 86400, step: 3600 }
  };

  const series = {};
  await Promise.all(Object.entries(rangeJobs).map(async ([name, job]) => {
    try {
      const result = await prom.queryRange(job.expr, job.start, now, job.step);
      series[name] = rangeValues(result);
    } catch (err) {
      series[name] = [];
    }
  }));

  const ingressPct = scaleToPct(series.rx);
  const egressPct = scaleToPct(series.tx);
  let throughputIngress = ingressPct;
  let throughputEgress = egressPct;
  let throughputSrc = series.rx.length ? series.rx : series.tx;
  if (!ingressPct.length && series.util.length) {
    throughputIngress = series.util.map((p) => num(p[1], 2));
    throughputEgress = series.util.map((p) => num(p[1] * 0.75, 2));
    throughputSrc = series.util;
  }
  const tpSlice = Math.min(
    60,
    throughputSrc.length || 60,
    throughputIngress.length || 60,
    throughputEgress.length || 60
  );

  const qvals = Object.values(q);
  const allFailed = qvals.length && qvals.every((v) => !v.ok);
  const lastUpdated = new Date().toISOString();
  const scrapedAt = isoFromUnix(latestTsFromResults(q)) || lastUpdated;
  events.forEach((e) => {
    if (!e.ts) e.ts = lastUpdated;
  });

  return {
    scope: sid ? "site" : "global",
    site_id: sid || null,
    last_updated: lastUpdated,
    scraped_at: scrapedAt,
    window: {
      throughput_start: isoFromUnix(now - 3600),
      throughput_end: isoFromUnix(now),
      spark_start: isoFromUnix(now - 86400),
      spark_end: isoFromUnix(now),
      heatmap_start: isoFromUnix(now - 7 * 86400),
      heatmap_end: isoFromUnix(now)
    },
    prometheus_unavailable: !!allFailed,
    kpis,
    resources,
    gauges: {
      health: kpis.uptime.value,
      latency: kpis.latency.value,
      error: (() => {
        const links = samples(q.wanUp && q.wanUp.result);
        if (!links.length) return null;
        const down = links.filter((s) => s.value === 0).length;
        return num(100 * down / links.length, 1);
      })()
    },
    topology,
    events,
    insights,
    throughput: {
      times: throughputSrc.slice(-tpSlice).map((p) => p[0]),
      ingress: throughputIngress.slice(-tpSlice),
      egress: throughputEgress.slice(-tpSlice)
    },
    sparks: {
      devices: series.devices.map((p) => p[1]).slice(-24),
      uptime: series.health.map((p) => p[1]).slice(-24),
      clients: series.clients.map((p) => p[1]).slice(-24),
      latency: series.latency.map((p) => p[1]).slice(-24)
    },
    heatmap: buildHeatmap(series.load)
  };
}

function landingQueries() {
  return {
    sites: "count(count by (site_id) (device_info))",
    health: "avg(site_health_percent)",
    devicesTotal: "sum(site_devices_total:all)",
    devicesInfo: "count(device_info)",
    devicesUp: "sum(site_devices_up:all)",
    alerts: "count(ALERTS{alertstate=\"firing\"})",
    wanDown: "count(wan_link_up == 0)",
    deviceDown: "count(device_info == 0)"
  };
}

function buildLandingStats(q) {
  const sites = firstScalar(q, ["sites"]);
  let devices = firstScalar(q, ["devicesTotal"]);
  if (devices == null) devices = firstScalar(q, ["devicesInfo"]);
  let health = firstAvg(q, ["health"]);
  const up = firstScalar(q, ["devicesUp"]);
  if (health == null && devices && devices > 0 && up != null) {
    health = 100 * up / devices;
  }
  let incidents = firstScalar(q, ["alerts"]);
  if (incidents == null) {
    const wanDown = firstScalar(q, ["wanDown"]) || 0;
    const deviceDown = firstScalar(q, ["deviceDown"]) || 0;
    const any = (q.wanDown && q.wanDown.ok) || (q.deviceDown && q.deviceDown.ok);
    incidents = any ? wanDown + deviceDown : null;
  }
  return {
    sites: { value: sites != null ? Math.round(sites) : null, available: sites != null },
    uptime: { value: num(health, 2), unit: "%", available: health != null },
    devices: { value: devices != null ? Math.round(devices) : null, available: devices != null },
    incidents: { value: incidents != null ? Math.round(incidents) : null, available: incidents != null }
  };
}

async function getLandingStats(client) {
  const prom = client || new PrometheusClient();
  let q;
  try {
    q = await prom.queryMany(landingQueries(), 6);
  } catch (err) {
    return {
      prometheus_unavailable: true,
      error: "Monitoring data temporarily unavailable",
      last_updated: new Date().toISOString(),
      stats: {
        sites: { available: false },
        uptime: { available: false },
        devices: { available: false },
        incidents: { available: false }
      }
    };
  }
  const stats = buildLandingStats(q);
  const qvals = Object.values(q);
  const allFailed = qvals.length && qvals.every((v) => !v.ok);
  return {
    prometheus_unavailable: !!allFailed,
    last_updated: new Date().toISOString(),
    scraped_at: isoFromUnix(latestTsFromResults(q)),
    stats
  };
}

module.exports = {
  getDashboard,
  getLandingStats,
  landingQueries,
  buildLandingStats,
  instantQueries,
  buildKpis,
  buildTopology,
  buildEvents,
  buildHeatmap,
  scaleToPct,
  extractSiteId
};
