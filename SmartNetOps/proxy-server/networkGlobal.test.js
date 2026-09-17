"use strict";

/**
 * Catalog-level tests for the network service.
 *
 * REPLACES the previous version, which asserted that the primary queries were
 * raw `vmanage_*` metrics. That assertion encoded the bug: on a Meraki-heavy
 * estate those series do not exist, so every KPI came back null and the CXO
 * pages rendered blank. The tests below assert the CORRECT layering instead --
 * unified recording rule first, vendor metrics as fallbacks -- and keep the
 * original coverage of scoping, KPI arithmetic and series alignment.
 */

const assert = require("assert");
const CAT = require("./metricCatalog");
const { buildKpis, alignSeries, normalizeRegion, resolveRange } = require("./networkGlobalService");

/* ---- 1. every ladder leads with the unified namespace ------------------ */
function testLadderOrder() {
  const s = CAT.sel("", "");
  const UNIFIED_FIRST = {
    devicesTotal: "site_devices_total:all",
    devicesUp:    "site_devices_up:all",
    siteHealth:   "site_health_percent",
    wanUp:        "wan_link_up",
    wanTotal:     "wan_link_up",
    bfdUp:        "overlay_sessions_up",
    ompUp:        "overlay_sessions_up",
    bgpUp:        "overlay_sessions_up",
    latency:      "wan_link_latency_milliseconds",
    loss:         "wan_link_loss_percent",
    routers:      "device_info"
  };
  Object.keys(UNIFIED_FIRST).forEach(function (k) {
    const first = CAT.INSTANT[k](s)[0];
    assert.ok(first.indexOf(UNIFIED_FIRST[k]) >= 0,
      "FAIL: " + k + " must lead with " + UNIFIED_FIRST[k] + ", leads with: " + first);
  });

  // and each must have a vendor fallback below it, or a rules outage blanks the page
  ["devicesTotal", "devicesUp", "wanUp", "bfdUp", "latency"].forEach(function (k) {
    const ladder = CAT.INSTANT[k](s);
    assert.ok(ladder.length >= 2, "FAIL: " + k + " has no fallback rung");
    assert.ok(ladder.slice(1).some(function (e) {
      return /vmanage_|meraki_|sdwan_/.test(e);
    }), "FAIL: " + k + " has no raw-exporter fallback");
  });

  const rx = CAT.RANGE.rx(s);
  assert.ok(rx[0].indexOf("wan_link_rx_bits_per_second") >= 0);
  assert.ok(rx.some(function (e) { return e.indexOf("meraki_uplink_received") >= 0; }),
    "FAIL: throughput has no Meraki fallback — the reported fault");
  console.log("  ✓ every ladder leads with the unified rule and has a vendor fallback");
}

/* ---- 2. scoping ------------------------------------------------------- */
function testScoping() {
  const global = CAT.sel("", "");
  Object.keys(CAT.INSTANT).forEach(function (k) {
    CAT.INSTANT[k](global).forEach(function (e) {
      assert.ok(e.indexOf("site_id=") < 0, "FAIL: unscoped query carries site_id: " + e);
      assert.ok(e.indexOf("region=") < 0, "FAIL: unscoped query carries region: " + e);
    });
  });

  const site = CAT.sel("MY-1800", "");
  ["devicesTotal", "wanUp", "bfdUp", "latency"].forEach(function (k) {
    assert.ok(CAT.INSTANT[k](site)[0].indexOf('site_id="MY-1800"') >= 0,
      "FAIL: site scope missing on " + k);
  });

  // site_id must win over region — a contradictory matcher returns nothing
  const both = CAT.sel("MY-1800", "EMEA");
  assert.ok(both.indexOf('site_id="MY-1800"') >= 0);
  assert.ok(both.indexOf("region=") < 0, "FAIL: region leaked into a site-scoped selector");

  const region = CAT.sel("", "APAC");
  assert.ok(CAT.INSTANT.devicesTotal(region)[0].indexOf('region="APAC"') >= 0);

  // protocol labels must be injected INSIDE the brace, not appended after it
  const bfd = CAT.INSTANT.bfdUp(region)[0];
  assert.ok(/\{[^}]*region="APAC"[^}]*protocol="bfd"[^}]*\}/.test(bfd),
    "FAIL: malformed overlay selector: " + bfd);
  console.log("  ✓ scoping correct — global clean, site wins over region, labels well-formed");
}

/* ---- 3. label injection is escaped ------------------------------------ */
function testEscaping() {
  const evil = CAT.sel('X" or up{', "");
  assert.ok(evil.indexOf('\\"') >= 0, "FAIL: quote not escaped: " + evil);
  assert.ok(normalizeRegion("'; drop") === "", "FAIL: unknown region not rejected");
  assert.ok(normalizeRegion("apac") === "APAC", "region should be case-insensitive");
  assert.ok(normalizeRegion("GLOBAL") === "", "GLOBAL means unscoped");
  console.log("  ✓ label values escaped, unknown regions rejected");
}

/* ---- 4. KPI arithmetic (ported from the previous suite) ---------------- */
function testKpis() {
  const r = {
    devicesTotal: { value: 3,  rung: 0 },
    devicesUp:    { value: 2,  rung: 0 },
    siteHealth:   { value: null, rung: -1 },
    routers:      { value: 3,  rung: 0 },
    siteCount:    { value: 1,  rung: 0 },
    wanUp:        { value: 3,  rung: 0 },
    wanTotal:     { value: 4,  rung: 0 },
    ompUp:        { value: 8,  rung: 0 },
    ompTotal:     { value: 10, rung: 0 },
    bfdUp:        { value: 40, rung: 0 },
    bfdTotal:     { value: 42, rung: 0 },
    bgpUp:        { value: 6,  rung: 0 },
    bgpTotal:     { value: 6,  rung: 0 },
    controlUp:    { value: 12, rung: 0 },
    latency:      { value: 31.24, rung: 0 },
    jitter:       { value: null, rung: -1 },
    loss:         { value: 0.42, rung: 0 }
  };
  const k = buildKpis(r);
  assert.strictEqual(k.reachability.value, 66.7, "2/3 should be 66.7%");
  assert.strictEqual(k.reachability.up, 2);
  assert.strictEqual(k.reachability.total, 3);
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
  assert.strictEqual(k.wan_availability.value, 75);
  assert.strictEqual(k.latency_ms.value, 31.2);
  assert.strictEqual(k.loss_percent.value, 0.4);
  assert.strictEqual(k.jitter_ms.available, false, "absent metric must be unavailable, not 0");

  // site_health_percent must win over the derived ratio when present
  const k2 = buildKpis(Object.assign({}, r, { siteHealth: { value: 91.25, rung: 0 } }));
  assert.strictEqual(k2.reachability.value, 91.3,
    "FAIL: precomputed site_health_percent should take precedence");

  assert.strictEqual(buildKpis({}).omp_down.available, false);
  assert.strictEqual(buildKpis({}).reachability.value, null,
    "FAIL: empty input must yield null, never a fabricated 0%");
  console.log("  ✓ KPI arithmetic correct; absent metrics stay null, never 0");
}

/* ---- 5. series alignment (ported) ------------------------------------- */
function testAlign() {
  const a = alignSeries([[1, 10], [3, 30]], [[2, 20], [3, 40]]);
  assert.deepStrictEqual(a.times, [1, 2, 3]);
  assert.deepStrictEqual(a.ingress, [10, null, 30]);
  assert.deepStrictEqual(a.egress, [null, 20, 40]);
  assert.deepStrictEqual(alignSeries([], []).times, []);
  console.log("  ✓ series alignment preserves gaps as null, not zero");
}

/* ---- 6. range vocabulary ---------------------------------------------- */
function testRanges() {
  assert.strictEqual(resolveRange("24h"), "24h");
  assert.strictEqual(resolveRange("nonsense"), "1h");
  assert.strictEqual(resolveRange(undefined), "1h");
  console.log("  ✓ range resolution falls back safely");
}

/* ---- 7. diagnostics probe set covers all layers ----------------------- */
function testProbes() {
  const prefixes = CAT.PROBES.map(function (p) { return p[0].split(" ")[0]; });
  ["UNIFIED", "VMANAGE", "MERAKI", "SDWAN"].forEach(function (layer) {
    assert.ok(prefixes.indexOf(layer) >= 0, "FAIL: diag does not probe the " + layer + " layer");
  });
  assert.ok(CAT.PROBES.some(function (p) {
    return p[0].indexOf("meraki_uplink_util_percent") >= 0;
  }), "FAIL: diag should flag the metric the Grafana dashboards query but nothing emits");
  console.log("  ✓ diagnostics probe every layer (" + CAT.PROBES.length + " probes)");
}

testLadderOrder();
testScoping();
testEscaping();
testKpis();
testAlign();
testRanges();
testProbes();
console.log("networkGlobal.test.js ok");
