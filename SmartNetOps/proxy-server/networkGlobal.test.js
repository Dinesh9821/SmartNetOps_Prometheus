"use strict";

const assert = require("assert");
const { networkGlobalQueries, buildKpis, alignSeries, getNetworkGlobal } = require("./networkGlobalService");

function vec(metric, value) {
  return { metric, value: [Date.now() / 1000, String(value)] };
}

function ok(result) {
  return { ok: true, result };
}

function testQueriesUnscoped() {
  const q = networkGlobalQueries();
  Object.values(q).forEach((expr) => {
    assert.ok(!expr.includes("site_id="), expr);
  });
  assert.ok(q.reachable.includes("vmanage_device_reachable"));
  assert.ok(q.controlUp.includes("vmanage_control_connections_up"));
}

function testQueriesSiteScoped() {
  const q = networkGlobalQueries("MY-1800");
  Object.values(q).forEach((expr) => {
    assert.ok(expr.includes('site_id="MY-1800"'), expr);
  });
}

function testKpis() {
  const q = {
    reachable: ok([
      vec({ hostname: "r1", device_type: "vedge" }, 1),
      vec({ hostname: "r2", device_type: "vedge" }, 1),
      vec({ hostname: "r3", device_type: "vedge" }, 0)
    ]),
    ompUp: ok([vec({}, 8)]),
    ompTotal: ok([vec({}, 10)]),
    bfdUp: ok([vec({}, 40)]),
    bfdTotal: ok([vec({}, 42)]),
    bgpUp: ok([vec({}, 6)]),
    bgpTotal: ok([vec({}, 6)]),
    controlUp: ok([vec({}, 12)])
  };
  const k = buildKpis(q);
  assert.strictEqual(k.reachability.value, 66.7);
  assert.strictEqual(k.reachability.up, 2);
  assert.strictEqual(k.unreachable.value, 1);
  assert.strictEqual(k.sdwan_devices.value, 3);
  assert.strictEqual(k.routers.value, 3);
  assert.strictEqual(k.omp_up.value, 8);
  assert.strictEqual(k.omp_down.value, 2);
  assert.strictEqual(k.bfd_up.value, 40);
  assert.strictEqual(k.bfd_down.value, 2);
  assert.strictEqual(k.bgp_established.value, 6);
  assert.strictEqual(k.bgp_down.value, 0);
  assert.strictEqual(k.control_connections.value, 12);
  assert.strictEqual(buildKpis({}).omp_down.available, false);
}

function testAlign() {
  const aligned = alignSeries([[1, 10], [3, 30]], [[2, 20], [3, 40]]);
  assert.deepStrictEqual(aligned.times, [1, 2, 3]);
  assert.deepStrictEqual(aligned.ingress, [10, null, 30]);
  assert.deepStrictEqual(aligned.egress, [null, 20, 40]);
}

async function testGetNetworkGlobalMock() {
  const client = {
    queryMany: async (named) => {
      const out = {};
      Object.keys(named).forEach((k) => { out[k] = { ok: true, result: [] }; });
      out.reachable = ok([vec({ hostname: "edge-1", device_type: "vedge" }, 1)]);
      out.ompUp = ok([vec({}, 4)]);
      out.ompTotal = ok([vec({}, 4)]);
      return out;
    },
    queryRange: async (expr, start, end, step) => {
      const now = Math.floor(Date.now() / 1000);
      const v = expr.includes("rx") ? "100" : "50";
      return [{ metric: {}, values: [[now - 60, v], [now, v]] }];
    }
  };
  const data = await getNetworkGlobal("", client);
  assert.strictEqual(data.scope, "global");
  assert.ok(data.kpis.reachability.available);
  assert.strictEqual(data.kpis.sdwan_devices.value, 1);
  assert.strictEqual(data.range, "1h");
  assert.ok(data.throughput.times.length >= 2);
  assert.ok(data.throughput.ingress.some((v) => v === 100));
  assert.ok(data.throughput.egress.some((v) => v === 50));

  let span = 0;
  const week = await getNetworkGlobal("", {
    queryMany: client.queryMany,
    queryRange: async (expr, start, end) => {
      span = end - start;
      return client.queryRange(expr, start, end);
    }
  }, "7d");
  assert.strictEqual(week.range, "7d");
  assert.ok(span >= 6 * 86400);

  const site = await getNetworkGlobal("MY-1800", {
    queryMany: async (named) => {
      Object.values(named).forEach((expr) => {
        assert.ok(expr.includes('site_id="MY-1800"'), expr);
      });
      return client.queryMany(named);
    },
    queryRange: async (expr) => {
      assert.ok(expr.includes('site_id="MY-1800"'), expr);
      return client.queryRange(expr);
    }
  });
  assert.strictEqual(site.scope, "site");
  assert.strictEqual(site.site_id, "MY-1800");

  const bad = await getNetworkGlobal("bad id");
  assert.strictEqual(bad.scope, "invalid");
}

testQueriesUnscoped();
testQueriesSiteScoped();
testKpis();
testAlign();
testGetNetworkGlobalMock().then(() => {
  console.log("networkGlobal.test.js ok");
}).catch((err) => {
  console.error(err);
  process.exit(1);
});
