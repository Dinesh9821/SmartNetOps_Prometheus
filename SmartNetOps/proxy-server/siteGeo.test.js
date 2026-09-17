"use strict";

const assert = require("assert");
const geo = require("./siteGeoService");

/* ---- 1. pipe-delimited parsing (the documented upstream shape) --------- */
const p = geo.parseSite("US-0030 | 12 Main St | Austin | TX | United States | 73301");
assert.strictEqual(p.site_id, "US-0030");
assert.strictEqual(p.city, "Austin");
assert.strictEqual(p.state, "TX");
assert.strictEqual(p.country, "United States");
console.log("  ✓ pipe-delimited site string parsed");

/* object form is also accepted */
const o = geo.parseSite({ site_id: "sg-0033", city: "Singapore", country: "Singapore" });
assert.strictEqual(o.site_id, "SG-0033", "site ids must normalise to upper case");
console.log("  ✓ object form parsed and site_id normalised");

/* ---- 2. tolerant list extraction, matching the existing /proxy1 reader - */
assert.strictEqual(geo.extractList(["a", "b"]).length, 2);
assert.strictEqual(geo.extractList({ sites: ["a"] }).length, 1);
assert.strictEqual(geo.extractList({ data: ["a", "b", "c"] }).length, 3);
assert.strictEqual(geo.extractList({ AMER: ["a"], EMEA: ["b"] }).length, 2);
assert.strictEqual(geo.extractList(null).length, 0);
console.log("  ✓ every /proxy1 response shape handled");

/* ---- 3. coordinate resolution ladder ---------------------------------- */
(async function () {
  // US site with a state -> state centroid, not country centroid
  const us = await geo.resolveCoords(
    geo.parseSite("US-0030 | 12 Main St | Austin | TX | United States | 73301"));
  assert.strictEqual(us.precision, "state-centroid");
  assert.ok(us.lat > 29 && us.lat < 33, "Texas latitude expected, got " + us.lat);
  console.log("  ✓ US site resolves to state centroid (" +
              us.lat.toFixed(2) + ", " + us.lng.toFixed(2) + ")");

  // Non-US site -> country centroid
  const sg = await geo.resolveCoords(
    geo.parseSite("SG-0033 |  | Singapore |  | Singapore | "));
  assert.strictEqual(sg.precision, "country-centroid");
  assert.ok(sg.lat > -1 && sg.lat < 4, "Singapore latitude expected");
  console.log("  ✓ non-US site resolves to country centroid");

  // Country missing entirely -> inferred from the site-ID prefix
  const pl = await geo.resolveCoords(geo.parseSite("PL-0035 |  |  |  |  | "));
  assert.strictEqual(geo.countryOf(geo.parseSite("PL-0035 | | | | |")), "Poland");
  assert.ok(pl.lat > 49 && pl.lat < 55, "Poland latitude expected, got " + pl.lat);
  console.log("  ✓ country inferred from site-ID prefix when the field is blank");

  // Explicit coordinates always win
  const exact = await geo.resolveCoords(
    geo.parseSite({ site_id: "US-9999", lat: 40.7, lng: -74.0 }));
  assert.strictEqual(exact.precision, "exact");
  assert.strictEqual(exact.lat, 40.7);
  console.log("  ✓ upstream lat/lng overrides every fallback");

  // Two sites in the same state must not land on the identical pixel
  const a = await geo.resolveCoords(geo.parseSite("US-0063 | | | TX | United States |"));
  const b = await geo.resolveCoords(geo.parseSite("US-0087 | | | TX | United States |"));
  assert.notStrictEqual(a.lat, b.lat, "co-located sites must be scattered");
  console.log("  ✓ co-located sites deterministically scattered, not stacked");

  /* ---- 4. state name spelled out, not just the code -------------------- */
  assert.strictEqual(geo.stateCode({ state: "California" }), "CA");
  assert.strictEqual(geo.stateCode({ state: "tx" }), "TX");
  assert.strictEqual(geo.stateCode({ state: "" }), "");
  console.log("  ✓ state names and codes both resolve");

  /* ---- 5. status thresholds ------------------------------------------- */
  assert.strictEqual(geo.statusOf({ devices: 4, devices_up: 4 }), "HEALTHY");
  assert.strictEqual(geo.statusOf({ devices: 10, devices_up: 9 }), "DEGRADED");
  assert.strictEqual(geo.statusOf({ devices: 10, devices_up: 5 }), "CRITICAL");
  assert.strictEqual(geo.statusOf({ devices: 3, devices_up: 0 }), "DOWN");
  assert.strictEqual(geo.statusOf(null), "NO_DATA");
  console.log("  ✓ site status thresholds correct");

  /* ---- 6. end-to-end with stubbed /proxy1 and Prometheus --------------- */
  const fakeFetch = async function (url, init) {
    const body = JSON.parse(init.body);
    const rows = {
      AMER: ["US-0030 | 1 A St | Austin | TX | United States | 73301",
             "MX-7633 | 2 B St | Monterrey |  | Mexico | 64000"],
      EMEA: ["PL-0035 | 3 C St | Warsaw |  | Poland | 00-001"],
      APAC: ["SG-0033 | 4 D St | Singapore |  | Singapore | 018956"],
      CHINA: []
    }[body.region] || [];
    return { ok: true, text: async () => JSON.stringify({ sites: rows }) };
  };

  /* Prometheus carrying the UNIFIED recording rules (Meraki + vManage fan-in),
     which is what siteHealth now queries first. */
  const fakeProm = {
    baseUrl: "http://fake:9090",
    async query(expr) {
      const mk = (labels, v) => ({ metric: labels, value: [1700000000, String(v)] });
      const US = { site_id: "US-0030", region: "AMER", country: "United States", priority: "P1" };
      const SG = { site_id: "SG-0033", region: "APAC", country: "Singapore", priority: "P1" };
      if (expr.indexOf("site_devices_total:all") >= 0) return [mk(US, 2), mk(SG, 1)];
      if (expr.indexOf("site_devices_up:all") >= 0)    return [mk(US, 1), mk(SG, 1)];
      if (expr.indexOf("site_health_percent") >= 0)    return [mk(US, 50), mk(SG, 100)];
      if (expr.indexOf("wan_link_up") >= 0)            return [mk(US, 2)];
      if (expr.indexOf("vmanage_device_uptime_seconds") >= 0) return [mk(US, 864000)];
      return [];
    },
    async queryMany(named) {
      const out = {};
      for (const k of Object.keys(named)) out[k] = { ok: true, result: await this.query(named[k]) };
      return out;
    }
  };

  const res = await geo.getSiteMap("", { fetchFn: fakeFetch, prom: fakeProm, noCache: true });
  assert.strictEqual(res.total, 4, "expected 4 unique sites, got " + res.total);
  assert.strictEqual(res.placed, 4, "every site must get coordinates");
  assert.strictEqual(res.monitored, 2, "only 2 sites have telemetry");

  const us0030 = res.sites.find((s) => s.site_id === "US-0030");
  assert.strictEqual(us0030.devices, 2);
  assert.strictEqual(us0030.availability, 50);
  assert.strictEqual(us0030.status, "CRITICAL");
  assert.strictEqual(us0030.uptime_days, 10);

  const mx = res.sites.find((s) => s.site_id === "MX-7633");
  assert.strictEqual(mx.status, "NO_DATA", "unmonitored site must say so, not fake health");
  assert.ok(mx.lat != null, "unmonitored sites still get plotted");

  console.log("  ✓ end-to-end: " + res.total + " sites, " + res.placed +
              " placed, " + res.monitored + " with live telemetry");
  console.log("    precision mix:", JSON.stringify(res.precision_counts));
  console.log("    by region:", JSON.stringify(res.by_region));

  /* ---- 7. region scoping ---------------------------------------------- */
  const apac = await geo.getSiteMap("APAC", { fetchFn: fakeFetch, prom: fakeProm, noCache: true });
  assert.strictEqual(apac.total, 1);
  assert.strictEqual(apac.region, "APAC");
  assert.strictEqual(apac.view.zoom, 4);
  console.log("  ✓ region=APAC returns only APAC sites with an APAC map view");

  /* ---- 8. upstream failure degrades, never throws ---------------------- */
  const brokenFetch = async function () { throw new Error("upstream down"); };
  const degraded = await geo.getSiteMap("", { fetchFn: brokenFetch, prom: fakeProm, noCache: true });
  assert.strictEqual(degraded.total, 0);
  assert.ok(degraded.source_errors.length === 4, "each region error must be reported");
  console.log("  ✓ site API outage degrades cleanly and reports per-region errors");

  console.log("siteGeo.test.js ok");
})().catch((e) => { console.error(e); process.exit(1); });
