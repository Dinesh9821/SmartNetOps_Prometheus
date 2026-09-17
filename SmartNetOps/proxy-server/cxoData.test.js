"use strict";

/**
 * Reproduces the reported fault: "no data on the CXO pages".
 *
 * Scenario A — Meraki-only estate with unified recording rules loaded.
 *   The previous implementation queried vmanage_* first and got nothing back,
 *   so every KPI rendered blank. The catalog must resolve via the unified
 *   namespace instead.
 *
 * Scenario B — rules NOT loaded, raw Meraki only.
 *   Must still populate by falling through to the raw exporter rung.
 *
 * Scenario C — vManage-only estate. Must keep working (no regression).
 */

const assert = require("assert");
const svc = require("./networkGlobalService");
const CAT = require("./metricCatalog");

function S(labels, v) { return { metric: labels, value: [1700000000, String(v)] }; }
function R(labels, pts) { return { metric: labels, values: pts.map((p) => [p[0], String(p[1])]) }; }

/**
 * A fake Prometheus that knows a set of metric names and, crucially, applies
 * the outer aggregation the same way Prometheus would. Without this the test
 * cannot tell count() from sum() and proves nothing.
 */
function fakeProm(known, rangeKnown) {
  const asked = [];

  function lookup(expr, table) {
    for (const name of Object.keys(table || {})) {
      const re = new RegExp("(^|[^a-zA-Z0-9_:])" +
        name.replace(/[:]/g, "\\:") + "([^a-zA-Z0-9_:]|$)");
      if (re.test(expr)) return table[name];
    }
    return null;
  }

  /** Apply `metric{...} == N` / `> N` style filters. */
  function applyComparison(expr, series) {
    const m = expr.match(/(==|!=|>=|<=|>|<)\s*(-?\d+(?:\.\d+)?)\s*\)?\s*$/);
    if (!m) return series;
    const op = m[1], n = Number(m[2]);
    return series.filter(function (s) {
      const v = Number(s.value[1]);
      return op === "==" ? v === n : op === "!=" ? v !== n
           : op === ">=" ? v >= n : op === "<=" ? v <= n
           : op === ">"  ? v > n  : v < n;
    });
  }

  function aggregate(expr, series) {
    const vals = series.map(function (s) { return Number(s.value[1]); });
    const outer = expr.trim().match(/^(count|sum|avg|max|min)\b/);
    const fn = outer ? outer[1] : null;

    // `count by (...)` / `sum by (...)` keep one series per group.
    const grouped = /^(count|sum|avg|max|min)\s+by\s*\(/.test(expr.trim());
    if (grouped) {
      const groups = {};
      series.forEach(function (s) {
        const key = JSON.stringify(s.metric);
        (groups[key] = groups[key] || []).push(Number(s.value[1]));
      });
      return Object.keys(groups).map(function (k) {
        const g = groups[k];
        const v = fn === "count" ? g.length
                : fn === "sum" ? g.reduce(function (a, b) { return a + b; }, 0)
                : fn === "avg" ? g.reduce(function (a, b) { return a + b; }, 0) / g.length
                : fn === "max" ? Math.max.apply(null, g) : Math.min.apply(null, g);
        return { metric: JSON.parse(k), value: [1700000000, String(v)] };
      });
    }

    if (!fn) return series;
    if (!vals.length) return [];
    const v = fn === "count" ? vals.length
            : fn === "sum" ? vals.reduce(function (a, b) { return a + b; }, 0)
            : fn === "avg" ? vals.reduce(function (a, b) { return a + b; }, 0) / vals.length
            : fn === "max" ? Math.max.apply(null, vals) : Math.min.apply(null, vals);
    return [{ metric: {}, value: [1700000000, String(v)] }];
  }

  return {
    baseUrl: "http://fake:9090",
    asked: asked,
    async query(expr) {
      asked.push(expr);
      const hit = lookup(expr, known);
      if (!hit) return [];
      return aggregate(expr, applyComparison(expr, hit));
    },
    async queryRange(expr) {
      asked.push(expr);
      return lookup(expr, rangeKnown) || [];
    },
    async queryMany(named) {
      const out = {};
      for (const k of Object.keys(named)) {
        try { out[k] = { ok: true, result: await this.query(named[k]) }; }
        catch (e) { out[k] = { ok: false, error: e.message, result: [] }; }
      }
      return out;
    }
  };
}

(async function () {

  /* ══ A. Meraki-only estate, unified rules LOADED ═════════════════════ */
  const L = { region: "AMER", country: "United States", site_id: "US-0030", priority: "P1" };
  const promA = fakeProm({
    "site_devices_total:all": [S(L, 8)],
    "site_devices_up:all":    [S(L, 7)],
    "site_health_percent":    [S(L, 87.5)],
    "device_info":            [S(Object.assign({ role: "ROUTER" }, L), 1)],
    "wan_link_up":            [S(L, 1), S(L, 1), S(L, 0)],
    "wan_link_utilization_percent": [S(L, 42.5)],
    "wan_link_latency_milliseconds": [S(L, 31.2)],
    "wan_link_loss_percent":  [S(L, 0.4)],
    "meraki_site_devices_total": [S(L, 8)],
    "meraki_uplink_status":   [S({ network: "US-0030" }, 1)],
    "meraki_exporter_up":     [S({}, 1)]
  }, {
    "wan_link_rx_bits_per_second": [R(L, [[1700000000, 4.1e8], [1700000030, 4.4e8]])],
    "wan_link_tx_bits_per_second": [R(L, [[1700000000, 2.0e8], [1700000030, 2.2e8]])]
  });

  let d = await svc.getNetworkGlobal("", promA, "1h");
  assert.strictEqual(d.prometheus_unavailable, false, "FAIL: reported unavailable with data present");
  assert.strictEqual(d.kpis.reachability.value, 87.5,
    "FAIL: availability should come from site_health_percent, got " + d.kpis.reachability.value);
  assert.strictEqual(d.kpis.sdwan_devices.value, 8);
  assert.strictEqual(d.kpis.wan_links_up.value, 2, "wan_link_up == 1 should count 2 of 3");
  assert.strictEqual(d.kpis.wan_links_up.total, 3);
  assert.ok(d.throughput.times.length > 0, "FAIL: throughput blank");
  assert.ok(d.sources.devicesTotal.expr.indexOf("site_devices_total:all") >= 0,
    "FAIL: did not use the unified rung, used " + d.sources.devicesTotal.expr);
  assert.strictEqual(d.sources.devicesTotal.rung, 0, "unified must be rung 0");
  console.log("  ✓ A: Meraki-only + unified rules → availability " +
              d.kpis.reachability.value + "%, " + d.metrics_resolved + "/" +
              d.metrics_total + " metrics resolved");
  console.log("      devices via:", d.sources.devicesTotal.expr);

  /* ══ B. NO recording rules — raw Meraki only ═════════════════════════ */
  const promB = fakeProm({
    "meraki_site_devices_total":  [S(L, 8)],
    "meraki_site_devices_online": [S(L, 7)],
    "meraki_uplink_status":       [S({ network: "US-0030" }, 1), S({ network: "US-0031" }, 1)],
    "meraki_uplink_latency_milliseconds": [S({}, 28.0)],
    "meraki_uplink_loss_percent": [S({}, 0.2)],
    "meraki_exporter_up":         [S({}, 1)]
  }, {
    "meraki_uplink_received_bytes_per_second": [R({}, [[1700000000, 5e7], [1700000030, 5.2e7]])],
    "meraki_uplink_sent_bytes_per_second":     [R({}, [[1700000000, 2e7], [1700000030, 2.1e7]])]
  });

  d = await svc.getNetworkGlobal("", promB, "1h");
  assert.strictEqual(d.prometheus_unavailable, false,
    "FAIL: blanked when only raw Meraki exists — this is the reported bug");
  assert.strictEqual(d.kpis.sdwan_devices.value, 8, "FAIL: fell through to meraki_site_devices_total");
  assert.strictEqual(d.kpis.reachability.value, 87.5, "FAIL: ratio fallback wrong");
  assert.ok(d.throughput.times.length > 0, "FAIL: no throughput from raw Meraki");
  assert.ok(d.sources["throughput.rx"].expr.indexOf("meraki_uplink_received") >= 0,
    "FAIL: throughput should fall to Meraki, got " + d.sources["throughput.rx"].expr);
  assert.ok(d.sources["throughput.rx"].rung > 0, "should be a lower rung, not the preferred one");
  console.log("  ✓ B: no rules, raw Meraki only → still populates (rung " +
              d.sources["throughput.rx"].rung + ")");
  console.log("      throughput via:", d.sources["throughput.rx"].expr);

  /* ══ C. vManage-only estate — no regression ══════════════════════════ */
  const promC = fakeProm({
    "vmanage_site_devices_total":     [S(L, 12)],
    "vmanage_site_devices_reachable": [S(L, 12)],
    "vmanage_bfd_sessions_up":        [S(L, 40)],
    "vmanage_bfd_sessions_total":     [S(L, 42)],
    "vmanage_site_wan_links_up":      [S(L, 3)],
    "vmanage_site_wan_links_total":   [S(L, 4)],
    "vmanage_bfd_session_latency_ms": [S(L, 55)],
    "vmanage_exporter_up":            [S({}, 1)]
  }, {
    "vmanage_wan_link_rx_bits_per_second": [R(L, [[1700000000, 9e8]])]
  });

  d = await svc.getNetworkGlobal("", promC, "1h");
  assert.strictEqual(d.kpis.reachability.value, 100);
  assert.strictEqual(d.kpis.bfd_up.value, 40);
  assert.strictEqual(d.kpis.wan_availability.value, 75);
  assert.strictEqual(d.kpis.latency_ms.value, 55);
  console.log("  ✓ C: vManage-only still works (no regression) — " +
              d.kpis.reachability.value + "% / BFD " + d.kpis.bfd_up.value + "/" + d.kpis.bfd_up.total);

  /* ══ D. genuinely empty Prometheus ═══════════════════════════════════ */
  d = await svc.getNetworkGlobal("", fakeProm({}, {}), "1h");
  assert.strictEqual(d.prometheus_unavailable, true, "FAIL: empty must report unavailable");
  assert.strictEqual(d.metrics_resolved, 0);
  console.log("  ✓ D: genuinely empty Prometheus reports unavailable, not fake zeros");

  /* ══ E. region scoping reaches every rung ════════════════════════════ */
  const promE = fakeProm({ "site_devices_total:all": [S(L, 5)] }, {});
  d = await svc.getNetworkGlobal("", promE, "1h", { region: "EMEA" });
  assert.ok(promE.asked.some((e) => e.indexOf('region="EMEA"') >= 0),
    "FAIL: region never reached PromQL");
  assert.strictEqual(d.region, "EMEA");
  console.log("  ✓ E: region matcher applied across the catalog");

  /* ══ F. overlay protocol labels are correct ══════════════════════════ */
  const promF = fakeProm({ "overlay_sessions_up": [S({ protocol: "bfd" }, 100)] }, {});
  await svc.getNetworkGlobal("", promF, "1h");
  assert.ok(promF.asked.some((e) => e.indexOf('protocol="bfd"') >= 0),
    "FAIL: overlay_sessions_up must be filtered by protocol");
  assert.ok(promF.asked.some((e) => e.indexOf('protocol="omp"') >= 0));
  assert.ok(promF.asked.some((e) => e.indexOf('protocol="bgp"') >= 0));
  console.log("  ✓ F: overlay_sessions_* correctly split by protocol label");

  /* ══ G. diagnostics identify the layer that is broken ════════════════ */
  const diag = await svc.getNetworkDiagnostics(promB);
  assert.strictEqual(diag.layers.unified, false);
  assert.strictEqual(diag.layers.meraki, true);
  assert.ok(diag.hints.some((h) => h.indexOf("unified recording rules are producing NO series") >= 0),
    "FAIL: diag must name the missing unified layer");
  assert.ok(diag.hints.some((h) => h.indexOf("meraki_uplink_util_percent") >= 0),
    "FAIL: diag must flag the dead Grafana metric");
  console.log("  ✓ G: diagnostics report layers " + JSON.stringify(diag.layers) +
              " with " + diag.hints.length + " actionable hints");

  /* ══ H. DC rollup resolves through the unified per-site rules ════════ */
  const promH = fakeProm({
    "site_devices_total:all": [S(L, 6), S({ region: "EMEA", site_id: "PL-0035", priority: "P1" }, 4)],
    "site_devices_up:all":    [S(L, 6), S({ region: "EMEA", site_id: "PL-0035", priority: "P1" }, 2)],
    "site_health_percent":    [S(L, 100), S({ region: "EMEA", site_id: "PL-0035", priority: "P1" }, 50)]
  }, {});
  const dc = await svc.dcRollup(promH, "", null);
  assert.strictEqual(dc.count, 2);
  assert.strictEqual(dc.healthy, 1);
  assert.strictEqual(dc.critical, 1);
  assert.strictEqual(dc.sites[0].site_id, "PL-0035", "worst site must sort first");
  assert.strictEqual(dc.sites[0].availability, 50);
  console.log("  ✓ H: DC rollup — " + dc.count + " sites, worst first (" +
              dc.sites[0].site_id + " at " + dc.sites[0].availability + "%)");

  console.log("cxoData.test.js ok");
})().catch((e) => { console.error(e); process.exit(1); });
