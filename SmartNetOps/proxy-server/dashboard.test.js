"use strict";

const assert = require("assert");
const {
  instantQueries,
  buildKpis,
  buildTopology,
  buildEvents,
  buildHeatmap,
  scaleToPct,
  getDashboard
} = require("./dashboardService");

function vec(metric, value) {
  return { metric, value: [Date.now() / 1000, String(value)] };
}

function ok(result) {
  return { ok: true, result };
}

function testSiteScopedPromql() {
  const q = instantQueries("MY-1800");
  Object.entries(q).forEach(([name, expr]) => {
    assert.ok(
      expr.includes('site_id="MY-1800"'),
      `${name} must filter by site_id: ${expr}`
    );
  });
  const globalQ = instantQueries("");
  assert.ok(!globalQ.deviceInfo.includes("site_id="), "global device_info is unscoped");
  assert.ok(globalQ.alerts.includes("ALERTS"));
  assert.ok(!globalQ.alerts.includes("site_id="));
}

function testKpis() {
  const q = {
    devicesTotalAll: ok([vec({}, 12)]),
    devicesUpAll: ok([vec({}, 11)]),
    health: ok([vec({}, 91.6)]),
    clients: ok([vec({}, 40)]),
    latencyRec: ok([vec({}, 24.2)]),
    deviceInfo: ok([vec({ device: "r1" }, 1)])
  };
  const k = buildKpis(q);
  assert.strictEqual(k.devices.value, 12);
  assert.ok(k.uptime.available);
  assert.strictEqual(k.uptime.value, 91.6);
  assert.strictEqual(k.clients.value, 40);
  assert.strictEqual(k.latency.value, 24.2);
}

function testTopologyAndEvents() {
  const q = {
    deviceInfo: ok([
      vec({ device: "edge-1", source: "vmanage", site_id: "MY-1800" }, 1),
      vec({ device: "edge-2", source: "vmanage", site_id: "MY-1800" }, 0)
    ]),
    wanUp: ok([vec({ device: "edge-1", link: "WAN1", site_id: "MY-1800" }, 0)]),
    alerts: ok([vec({ alertname: "WanDown", severity: "critical", site_id: "MY-1800" }, 1)]),
    byRegion: ok([vec({ region: "APAC" }, 4)]),
    byRegionDown: ok([vec({ region: "APAC" }, 1)]),
    bySource: ok([vec({ source: "vmanage" }, 4)])
  };
  const siteTopo = buildTopology(q, "MY-1800");
  assert.ok(siteTopo.nodes.some((n) => n.label === "MY-1800" || n.id === "site"));
  assert.ok(siteTopo.critical >= 1);
  const fleet = buildTopology(q, "");
  assert.ok(fleet.nodes.some((n) => n.label === "APAC" || n.label === "Fleet"));
  const kpis = { latency: { available: true, value: 90 }, uptime: { available: true, value: 80 } };
  const events = buildEvents(q, kpis);
  assert.ok(events.some((e) => e.t === "WanDown" || e.t === "WAN link down"));
}

function testHeatmapAndScale() {
  const now = Math.floor(Date.now() / 1000);
  const points = [[now, 10], [now - 3600, 5]];
  const hm = buildHeatmap(points);
  assert.strictEqual(hm.length, 7);
  assert.strictEqual(hm[0].length, 24);
  const scaled = scaleToPct([[1, 50], [2, 100]]);
  assert.strictEqual(scaled[1], 100);
}

async function testGetDashboardMock() {
  const client = {
    queryMany: async (named) => {
      const out = {};
      Object.keys(named).forEach((k) => { out[k] = { ok: true, result: [] }; });
      out.deviceInfo = ok([vec({ device: "r1", region: "APAC", source: "vmanage" }, 1)]);
      out.devicesTotalAll = ok([vec({}, 1)]);
      out.health = ok([vec({}, 100)]);
      return out;
    },
    queryRange: async () => []
  };
  const global = await getDashboard("", client);
  assert.strictEqual(global.scope, "global");
  assert.ok(global.kpis.devices.available);
  const site = await getDashboard("MY-1800", client);
  assert.strictEqual(site.scope, "site");
  assert.strictEqual(site.site_id, "MY-1800");
  const bad = await getDashboard("bad id", client);
  assert.ok(bad.error);
}

function run() {
  testSiteScopedPromql();
  testKpis();
  testTopologyAndEvents();
  testHeatmapAndScale();
  return testGetDashboardMock();
}

run().then(() => {
  console.log("dashboard.test.js ok");
}).catch((err) => {
  console.error(err);
  process.exit(1);
});
