"use strict";

/**
 * Regression test for the reported fault: "no data on the Network page".
 *
 * Simulates a Prometheus that has the vManage exporter scraped but NO
 * recording rules loaded -- so wan_link_rx/tx_bits_per_second do not exist.
 * Before the fix the throughput panel rendered empty with no error.
 */

const assert = require("assert");
const svc = require("./networkGlobalService");

function series(labels, value) {
  return { metric: labels, value: [1700000000, String(value)] };
}
function rangeSeries(labels, points) {
  return { metric: labels, values: points.map((p) => [p[0], String(p[1])]) };
}

/* Prometheus with exporter metrics only -- recording rules absent. */
function promWithoutRules(seen) {
  return {
    baseUrl: "http://fake:9090",
    async query(expr) {
      seen.push(expr);
      if (expr.indexOf("vmanage_device_reachable") >= 0) {
        return [
          series({ hostname: "US-0030-SD01", site_id: "US-0030", region: "AMER", priority: "P1" }, 1),
          series({ hostname: "US-0030-SW01", site_id: "US-0030", region: "AMER", priority: "P1" }, 0)
        ];
      }
      if (expr.indexOf("vmanage_wan_links_up") >= 0) return [series({}, 3)];
      if (expr.indexOf("vmanage_wan_links_total") >= 0) return [series({}, 4)];
      if (expr.indexOf("vmanage_bfd_sessions_up") >= 0) return [series({}, 18)];
      if (expr.indexOf("vmanage_bfd_sessions_total") >= 0) return [series({}, 20)];
      return [];
    },
    async queryRange(expr) {
      seen.push(expr);
      // The recording rule does not exist in this Prometheus.
      if (/\bwan_link_(rx|tx)_bits_per_second/.test(expr) &&
          expr.indexOf("vmanage_") < 0) {
        return [];
      }
      if (expr.indexOf("vmanage_wan_link_rx_bits_per_second") >= 0) {
        return [rangeSeries({}, [[1700000000, 4e8], [1700000030, 4.2e8]])];
      }
      if (expr.indexOf("vmanage_wan_link_tx_bits_per_second") >= 0) {
        return [rangeSeries({}, [[1700000000, 2e8], [1700000030, 2.1e8]])];
      }
      return [];
    },
    async queryMany(named, conc) {
      const out = {};
      for (const k of Object.keys(named)) {
        try { out[k] = { ok: true, result: await this.query(named[k]) }; }
        catch (e) { out[k] = { ok: false, error: e.message, result: [] }; }
      }
      return out;
    }
  };
}

(async function run() {
  /* ---- 1. throughput falls back to the raw exporter metric -------------- */
  let seen = [];
  let res = await svc.getNetworkGlobal("", promWithoutRules(seen), "1h");

  assert.ok(res.throughput.times.length > 0,
    "FAIL: throughput still empty when recording rules are missing");
  assert.ok(res.throughput_source.rx.indexOf("vmanage_wan_link_rx") >= 0,
    "FAIL: did not fall back to the raw exporter metric, got " + res.throughput_source.rx);
  assert.ok(seen.some((e) => /sum\(wan_link_rx_bits_per_second/.test(e)),
    "FAIL: recording rule was never tried first");
  console.log("  ✓ throughput falls back to vmanage_wan_link_* when rules are absent");
  console.log("    rx source:", res.throughput_source.rx);

  /* ---- 2. region scoping emits a region matcher ------------------------- */
  seen = [];
  res = await svc.getNetworkGlobal("", promWithoutRules(seen), "24h", { region: "APAC" });
  assert.strictEqual(res.region, "APAC");
  assert.strictEqual(res.scope, "region");
  assert.ok(seen.some((e) => e.indexOf('region="APAC"') >= 0),
    "FAIL: region label matcher never reached PromQL");
  console.log("  ✓ region=APAC scopes every query via the region label");

  /* ---- 3. bad region is ignored, not injected --------------------------- */
  seen = [];
  res = await svc.getNetworkGlobal("", promWithoutRules(seen), "1h", { region: "'; drop" });
  assert.strictEqual(res.region, null, "FAIL: unknown region was not rejected");
  assert.ok(!seen.some((e) => e.indexOf("drop") >= 0),
    "FAIL: unsanitised region reached PromQL");
  console.log("  ✓ unknown region rejected before it reaches PromQL");

  /* ---- 4. site_id still wins over region ------------------------------- */
  seen = [];
  res = await svc.getNetworkGlobal("US-0030", promWithoutRules(seen), "1h", { region: "EMEA" });
  assert.strictEqual(res.scope, "site");
  assert.ok(seen.some((e) => e.indexOf('site_id="US-0030"') >= 0));
  assert.ok(!seen.some((e) => e.indexOf('region="EMEA"') >= 0),
    "FAIL: region matcher leaked into a site-scoped query");
  console.log("  ✓ site scope overrides region (no conflicting matchers)");

  /* ---- 5. new CXO KPIs are computed ------------------------------------ */
  res = await svc.getNetworkGlobal("", promWithoutRules([]), "1h");
  assert.strictEqual(res.kpis.wan_availability.value, 75,
    "FAIL: wan_availability wrong, got " + res.kpis.wan_availability.value);
  assert.strictEqual(res.kpis.reachability.value, 50);
  console.log("  ✓ wan_availability 3/4 = 75%, reachability 1/2 = 50%");

  /* ---- 6. range list is exposed to the UI ------------------------------ */
  assert.ok(res.ranges_available.length >= 10);
  assert.ok(res.regions_available.indexOf("EMEA") >= 0);
  console.log("  ✓ ranges (" + res.ranges_available.length + ") and regions exposed to the UI");

  /* ---- 7. diagnostics name the missing rules --------------------------- */
  const diag = await svc.getNetworkDiagnostics(promWithoutRules([]));
  assert.ok(diag.missing.some((n) => n.indexOf("RULE wan_link_rx") >= 0),
    "FAIL: diag did not flag the missing recording rule");
  assert.ok(diag.hints.length > 0, "FAIL: diag produced no remediation hint");
  console.log("  ✓ diagnostics flag " + diag.missing.length + " missing series with " +
              diag.hints.length + " hints");

  console.log("networkFallback.test.js ok");
})().catch((e) => { console.error(e); process.exit(1); });
