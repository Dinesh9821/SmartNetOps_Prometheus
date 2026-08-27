"use strict";

const assert = require("assert");
const {
  extractSiteId,
  validateSiteId,
  escapeLabel,
  snapshotQueries,
  buildWan,
  buildOspf,
  buildBgp,
  buildDevices,
  buildInterfaces,
  collectIssues,
  overallFrom,
  getSiteSnapshot,
  THRESHOLDS
} = require("./monitoringService");
const { PrometheusClient, samples } = require("./prometheusClient");

function vec(metric, value) {
  return { metric, value: [Date.now() / 1000, String(value)] };
}

function ok(result) {
  return { ok: true, result };
}

function testExtractAndValidate() {
  assert.strictEqual(extractSiteId("IND-PUN-001 | 12 Main | Pune"), "IND-PUN-001");
  assert.strictEqual(extractSiteId("MY-1800"), "MY-1800");
  assert.ok(validateSiteId("IND-PUN-001").ok);
  assert.ok(validateSiteId("MY-1800").ok);
  assert.ok(!validateSiteId("").ok);
  assert.ok(!validateSiteId("bad id with spaces").ok);
  assert.ok(!validateSiteId('evil"}or{job="x').ok);
  assert.ok(!validateSiteId("a".repeat(200)).ok);
}

function testPromqlIsSiteScoped() {
  const q = snapshotQueries("IND-PUN-001");
  Object.entries(q).forEach(([name, expr]) => {
    if (name === "protocolAvail") return;
    assert.ok(
      expr.includes('site_id="IND-PUN-001"'),
      `${name} must filter by site_id: ${expr}`
    );
    assert.ok(!expr.includes("IND-MUM"), "must not hardcode other sites");
  });
  const other = snapshotQueries("MY-1800");
  assert.ok(other.wanUp.includes('site_id="MY-1800"'));
  assert.ok(!other.wanUp.includes("IND-PUN-001"));
}

function testEscape() {
  assert.strictEqual(escapeLabel('abc"def'), 'abc\\"def');
}

function testHealthySite() {
  const q = {
    wanUp: ok([vec({ device: "r1", link: "WAN1", source: "vmanage" }, 1)]),
    wanRx: ok([vec({ device: "r1", link: "WAN1", source: "vmanage" }, 1e6)]),
    wanTx: ok([vec({ device: "r1", link: "WAN1", source: "vmanage" }, 2e6)]),
    wanUtil: ok([vec({ device: "r1", link: "WAN1", source: "vmanage" }, 12)]),
    wanCap: ok([vec({ device: "r1", link: "WAN1", source: "vmanage" }, 1e8)]),
    wanInfo: ok([vec({ device: "r1", link: "WAN1", provider: "ISP-A", circuit_id: "C1" }, 1)]),
    ospfState: ok([vec({ hostname: "r1", neighbor_id: "10.0.0.2", ifname: "Gi0/0", state: "full" }, 1)]),
    ospfUp: ok([vec({ hostname: "r1", neighbor_id: "10.0.0.2", ifname: "Gi0/0" }, 1)]),
    bgpState: ok([vec({ hostname: "r1", peer_addr: "10.1.1.1", remote_as: "65000", vpn_id: "0", state: "established" }, 1)]),
    bgpUp: ok([vec({ hostname: "r1", peer_addr: "10.1.1.1", vpn_id: "0" }, 1)]),
    deviceInfo: ok([vec({ device: "r1", type: "vedge", ident: "1.1.1.1", source: "vmanage" }, 1)]),
    vmanageReach: ok([vec({ hostname: "r1", system_ip: "1.1.1.1", device_role: "ROUTER" }, 1)]),
    ifOper: ok([vec({ hostname: "r1", ifname: "Gi0/0", vpn_id: "0" }, 1)]),
    merakiSiteTotal: ok([]),
    merakiDeviceUp: ok([]),
    bfdTotal: ok([vec({ hostname: "r1" }, 2)]),
    bfdUp: ok([vec({ hostname: "r1" }, 2)]),
    ompTotal: ok([vec({ hostname: "r1" }, 1)]),
    ompUp: ok([vec({ hostname: "r1" }, 1)])
  };
  const wan = buildWan(q);
  const ospf = buildOspf(q);
  const bgp = buildBgp(q);
  const devices = buildDevices(q);
  const ifaces = buildInterfaces(q);
  const meraki = { availability: { available: false, reason: "No Data" }, switch_port_errors: 0 };
  const sdwan = { bfd: { total: 2, up: 2 }, omp: { total: 1, up: 1 } };
  const issues = collectIssues(wan, ospf, bgp, devices, ifaces, meraki, sdwan);
  const overall = overallFrom({ prometheus_unavailable: false, wan, ospf, bgp, devices, interfaces: ifaces, meraki, sdwan, issues });
  assert.strictEqual(wan.links[0].status, "UP");
  assert.strictEqual(wan.links[0].provider, "ISP-A");
  assert.strictEqual(ospf.rows[0].tone, "healthy");
  assert.strictEqual(bgp.rows[0].tone, "healthy");
  assert.strictEqual(overall, "HEALTHY");
  assert.strictEqual(issues.filter((i) => i.severity === "CRITICAL").length, 0);
}

function testWanFailureAndUtilThresholds() {
  const q = {
    wanUp: ok([
      vec({ device: "r1", link: "WAN1" }, 1),
      vec({ device: "r1", link: "WAN2" }, 0)
    ]),
    wanUtil: ok([
      vec({ device: "r1", link: "WAN1" }, 82),
      vec({ device: "r1", link: "WAN2" }, 0)
    ])
  };
  const wan = buildWan(q);
  assert.strictEqual(wan.links.find((l) => l.link === "WAN2").status, "DOWN");
  assert.strictEqual(wan.links.find((l) => l.link === "WAN1").status, "DEGRADED");
  const stub = { rows: [], peers: 0, established: 0, neighbors: 0 };
  const devices = { rows: [] };
  const ifaces = { rows: [] };
  const meraki = { switch_port_errors: 0 };
  const sdwan = { bfd: { total: 0, up: 0 }, omp: { total: 0, up: 0 } };
  const issues = collectIssues(wan, stub, stub, devices, ifaces, meraki, sdwan);
  assert.ok(issues.some((i) => i.severity === "CRITICAL" && /WAN2/.test(i.title)));
  assert.ok(issues.some((i) => i.severity === "WARNING" && /82/.test(i.title)));
  assert.strictEqual(THRESHOLDS.wanUtilHigh, 80);
  assert.strictEqual(THRESHOLDS.wanUtilWarning, 60);
  assert.strictEqual(THRESHOLDS.wanUtilCritical, 95);
}

function testBgpAndOspfFailure() {
  const q = {
    ospfState: ok([vec({ hostname: "r1", neighbor_id: "9.9.9.9", ifname: "Gi0/1", state: "exstart" }, 1)]),
    bgpState: ok([vec({ hostname: "r1", peer_addr: "10.9.9.9", remote_as: "65001", vpn_id: "10", state: "idle" }, 1)]),
    bgpTotal: ok([vec({ hostname: "r1" }, 1)]),
    bgpUpCount: ok([vec({ hostname: "r1" }, 0)])
  };
  const ospf = buildOspf(q);
  const bgp = buildBgp(q);
  assert.strictEqual(ospf.rows[0].tone, "problem");
  assert.strictEqual(bgp.rows[0].tone, "problem");
  const wan = { links: [], total: 0, active: 0 };
  const issues = collectIssues(wan, ospf, bgp, { rows: [] }, { rows: [] }, { switch_port_errors: 0 }, { bfd: { total: 0, up: 0 }, omp: { total: 0, up: 0 } });
  assert.ok(issues.some((i) => i.section === "ospf"));
  assert.ok(issues.some((i) => i.section === "bgp" && /10.9.9.9/.test(i.title)));
}

function testDeviceDown() {
  const q = {
    deviceInfo: ok([vec({ device: "sw1", type: "switch", ident: "SN1", source: "meraki" }, 0)])
  };
  const devices = buildDevices(q);
  assert.strictEqual(devices.rows[0].status, "DOWN");
  const issues = collectIssues(
    { links: [], total: 0, active: 0 },
    { rows: [] }, { rows: [], peers: 0, established: 0 },
    devices, { rows: [] }, { switch_port_errors: 0 },
    { bfd: { total: 0, up: 0 }, omp: { total: 0, up: 0 } }
  );
  assert.ok(issues.some((i) => i.severity === "CRITICAL" && /sw1/.test(i.title)));
}

function testNoTelemetryUnknown() {
  const empty = { availability: { available: false, reason: "No Data" }, links: [], rows: [], total: 0, active: 0, peers: 0, established: 0 };
  const snapshot = {
    prometheus_unavailable: false,
    wan: empty, ospf: empty, bgp: empty, devices: empty,
    interfaces: empty, meraki: empty, sdwan: { availability: { available: false }, bfd: { total: 0, up: 0 }, omp: { total: 0, up: 0 } },
    issues: []
  };
  assert.strictEqual(overallFrom(snapshot), "UNKNOWN");
  snapshot.prometheus_unavailable = true;
  assert.strictEqual(overallFrom(snapshot), "UNKNOWN");
}

async function testPrometheusTimeoutAndUnavailable() {
  const timed = new PrometheusClient({
    timeoutMs: 20,
    fetchFn: (_url, opts) => new Promise((_resolve, reject) => {
      if (opts && opts.signal) {
        opts.signal.addEventListener("abort", () => {
          const e = new Error("aborted");
          e.name = "AbortError";
          reject(e);
        });
      }
    })
  });
  await assert.rejects(() => timed.query("up"), /timed out|unavailable/i);

  const down = new PrometheusClient({
    fetchFn: async () => { throw new Error("ECONNREFUSED"); }
  });
  await assert.rejects(() => down.query("up"), /unavailable/i);

  const fake = {
    async queryMany() { throw new Error("down"); }
  };
  const snap = await getSiteSnapshot("IND-PUN-001", fake);
  assert.strictEqual(snap.overall_status, "UNKNOWN");
  assert.ok(snap.prometheus_unavailable);
}

async function testPartialSectionFailure() {
  const client = {
    async queryMany(named) {
      const out = {};
      Object.keys(named).forEach((k) => {
        if (k.startsWith("bgp")) {
          out[k] = { ok: false, error: "timeout", result: [] };
        } else if (k === "wanUp") {
          out[k] = ok([vec({ device: "r1", link: "WAN1" }, 1)]);
        } else {
          out[k] = { ok: true, result: [] };
        }
      });
      return out;
    }
  };
  const snap = await getSiteSnapshot("SITE-A", client);
  assert.strictEqual(snap.site_id, "SITE-A");
  assert.ok(snap.wan.availability.available);
  assert.ok(!snap.bgp.availability.available);
  assert.ok(snap.query_errors.bgpState);
}

async function testQueryManyConcurrency() {
  const seen = [];
  let inflight = 0;
  let max = 0;
  const client = new PrometheusClient({
    fetchFn: async (url) => {
      inflight++;
      max = Math.max(max, inflight);
      seen.push(url);
      await new Promise((r) => setTimeout(r, 15));
      inflight--;
      return {
        ok: true,
        async json() {
          return { status: "success", data: { resultType: "vector", result: [] } };
        }
      };
    }
  });
  await client.queryMany({ a: "up", b: "up", c: "up", d: "up" }, 2);
  assert.ok(max <= 2, `expected concurrency <=2, got ${max}`);
  assert.strictEqual(seen.length, 4);
}

function testSamplesHelper() {
  const r = samples([vec({ a: "1" }, "3.5"), vec({ a: "2" }, "NaN")]);
  assert.strictEqual(r.length, 1);
  assert.strictEqual(r[0].value, 3.5);
}

async function run() {
  testExtractAndValidate();
  testPromqlIsSiteScoped();
  testEscape();
  testHealthySite();
  testWanFailureAndUtilThresholds();
  testBgpAndOspfFailure();
  testDeviceDown();
  testNoTelemetryUnknown();
  testSamplesHelper();
  await testPrometheusTimeoutAndUnavailable();
  await testPartialSectionFailure();
  await testQueryManyConcurrency();
  console.log("All monitoring tests passed");
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
