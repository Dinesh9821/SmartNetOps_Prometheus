"use strict";

/**
 * METRIC CATALOG
 *
 * WHY THIS FILE EXISTS
 *   The first cut of the CXO service queried raw `vmanage_*` metrics as the
 *   primary source. That was the wrong layer. The Grafana stack in this repo
 *   shows the real architecture:
 *
 *     rules/unified-rules.yml fans BOTH vendors into one vendor-neutral
 *     namespace -- device_info, site_devices_*:all, site_health_percent,
 *     wan_link_*, overlay_sessions_* -- all carrying
 *     {region, country, site_id, priority, source}.
 *
 *   complete-observability.json and inventory-dashboard.json query that
 *   neutral namespace. Only the four per-org carrier dashboards query raw
 *   meraki_* directly, and they filter on org_id, not region.
 *
 *   So: an estate that is mostly Meraki emits almost no `vmanage_*` series.
 *   Querying vmanage first returns empty and the page renders blank. That is
 *   the reported fault.
 *
 * THE FIX
 *   Every logical metric is a CANDIDATE LADDER, tried in order:
 *     1. unified recording rule   -- covers Meraki + vManage together
 *     2. vendor rollup            -- sdwan_*, meraki_site_*
 *     3. raw exporter metric      -- vmanage_*, meraki_*
 *   The first rung that returns series wins, and the winning expression is
 *   reported back to the UI so a blank panel is always traceable.
 *
 * LABEL NOTE
 *   The unified namespace carries region/country/site_id/priority on every
 *   series, so region scoping is a label matcher at every rung except the raw
 *   meraki_uplink_* metrics, which carry network/org_id instead. Those sit at
 *   the bottom of each ladder for that reason.
 */

/** Escape a label value for safe interpolation into PromQL. */
function esc(v) {
  return String(v === null || v === undefined ? "" : v)
    .replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "");
}

/**
 * Build a label selector. site_id wins over region -- a site implies its
 * region, and passing both risks a contradictory matcher.
 */
function sel(siteId, region, extra) {
  var parts = [];
  if (siteId) parts.push('site_id="' + esc(siteId) + '"');
  else if (region) parts.push('region="' + esc(region) + '"');
  if (extra) parts.push(extra);
  return parts.length ? "{" + parts.join(",") + "}" : "";
}

/** Same, but for metrics that do not carry region/site_id labels at all. */
function bare(extra) {
  return extra ? "{" + extra + "}" : "";
}

/* ─────────────────────────────────────────────── instant candidate ladders */

/**
 * Each entry returns an array of PromQL strings, best source first.
 * `s` is the scoped selector for this request.
 */
var INSTANT = {

  /* ---- device inventory and reachability ------------------------------ */

  // Total devices at the sites in scope.
  devicesTotal: function (s) {
    return [
      "sum(site_devices_total:all" + s + ")",
      "count(device_info" + s + ")",
      "sum(site_devices_total" + s + ")",
      "sum(vmanage_site_devices_total" + s + ")",
      "sum(meraki_site_devices_total" + s + ")",
      "count(vmanage_device_reachable" + s + ")"
    ];
  },

  // Devices currently up / reachable.
  devicesUp: function (s) {
    return [
      "sum(site_devices_up:all" + s + ")",
      "sum(site_devices_up" + s + ")",
      "sum(vmanage_site_devices_reachable" + s + ")",
      "sum(meraki_site_devices_online" + s + ")",
      "count(vmanage_device_reachable" + s + " >= 1)"
    ];
  },

  // Site-level health percentage, already computed by the unified rules.
  siteHealth: function (s) {
    return [
      "avg(site_health_percent" + s + ")"
    ];
  },

  // Distinct sites reporting telemetry.
  siteCount: function (s) {
    return [
      "count(count by (site_id) (site_devices_total:all" + s + "))",
      "count(count by (site_id) (device_info" + s + "))",
      "count(count by (site_id) (vmanage_device_reachable" + s + "))"
    ];
  },

  // Routers specifically. device_info carries a `role` label; the raw
  // vManage path falls back to the hostname convention (SD => router).
  routers: function (s) {
    var inner = s ? s.slice(0, -1) + ',role=~"ROUTER|SD|ASD"}' : '{role=~"ROUTER|SD|ASD"}';
    return [
      "count(device_info" + inner + ")",
      "sum(vmanage_site_routers_total" + s + ")"
    ];
  },

  /* ---- WAN circuits --------------------------------------------------- */

  wanUp: function (s) {
    return [
      "count(wan_link_up" + s + " == 1)",
      "sum(sdwan_site_wan_links_up" + s + ")",
      "sum(vmanage_site_wan_links_up" + s + ")",
      "sum(vmanage_wan_links_up" + s + ")",
      "count(meraki_uplink_status" + bare("") + " == 1)"
    ];
  },

  wanTotal: function (s) {
    return [
      "count(wan_link_up" + s + ")",
      "sum(sdwan_site_wan_links_total" + s + ")",
      "sum(vmanage_site_wan_links_total" + s + ")",
      "sum(vmanage_wan_links_total" + s + ")",
      "count(meraki_uplink_status)"
    ];
  },

  wanUtilAvg: function (s) {
    return [
      "avg(wan_link_utilization_percent" + s + ")",
      "avg(vmanage_wan_link_utilization_percent" + s + ")"
    ];
  },

  wanUtilMax: function (s) {
    return [
      "max(wan_link_utilization_percent" + s + ")",
      "max(vmanage_wan_link_utilization_percent" + s + ")"
    ];
  },

  wanCapacity: function (s) {
    return [
      "sum(wan_link_capacity_bits_per_second" + s + ")",
      "sum(vmanage_wan_link_capacity_bits_per_second" + s + ")",
      "sum(meraki_uplink_capacity_bits_per_second)"
    ];
  },

  /* ---- overlay sessions ----------------------------------------------- */

  bfdUp: function (s) {
    var o = s ? s.slice(0, -1) + ',protocol="bfd"}' : '{protocol="bfd"}';
    return [
      "sum(overlay_sessions_up" + o + ")",
      "sum(vmanage_bfd_sessions_up" + s + ")"
    ];
  },
  bfdTotal: function (s) {
    var o = s ? s.slice(0, -1) + ',protocol="bfd"}' : '{protocol="bfd"}';
    return [
      "sum(overlay_sessions_total" + o + ")",
      "sum(vmanage_bfd_sessions_total" + s + ")"
    ];
  },
  ompUp: function (s) {
    var o = s ? s.slice(0, -1) + ',protocol="omp"}' : '{protocol="omp"}';
    return [
      "sum(overlay_sessions_up" + o + ")",
      "sum(vmanage_omp_peers_up" + s + ")"
    ];
  },
  ompTotal: function (s) {
    var o = s ? s.slice(0, -1) + ',protocol="omp"}' : '{protocol="omp"}';
    return [
      "sum(overlay_sessions_total" + o + ")",
      "sum(vmanage_omp_peers_total" + s + ")"
    ];
  },
  bgpUp: function (s) {
    var o = s ? s.slice(0, -1) + ',protocol="bgp"}' : '{protocol="bgp"}';
    return [
      "sum(overlay_sessions_up" + o + ")",
      "sum(vmanage_bgp_neighbors_up" + s + ")"
    ];
  },
  bgpTotal: function (s) {
    var o = s ? s.slice(0, -1) + ',protocol="bgp"}' : '{protocol="bgp"}';
    return [
      "sum(overlay_sessions_total" + o + ")",
      "sum(vmanage_bgp_neighbors_total" + s + ")"
    ];
  },
  controlUp: function (s) {
    return ["sum(vmanage_control_connections_up" + s + ")"];
  },

  /* ---- transport quality ---------------------------------------------- */
  // NOTE the unit suffixes differ by source: the unified rule is
  // _milliseconds, the raw vManage BFD gauge is _ms. Both are milliseconds.

  latency: function (s) {
    return [
      "avg(wan_link_latency_milliseconds" + s + ")",
      "avg(vmanage_wan_link_latency_ms" + s + ")",
      "avg(vmanage_bfd_session_latency_ms" + s + ")",
      "avg(meraki_uplink_latency_milliseconds)"
    ];
  },
  jitter: function (s) {
    return [
      "avg(wan_link_jitter_milliseconds" + s + ")",
      "avg(vmanage_wan_link_jitter_ms" + s + ")",
      "avg(vmanage_bfd_session_jitter_ms" + s + ")"
    ];
  },
  loss: function (s) {
    return [
      "avg(wan_link_loss_percent" + s + ")",
      "avg(vmanage_wan_link_loss_percent" + s + ")",
      "avg(vmanage_bfd_session_loss_percent" + s + ")",
      "avg(meraki_uplink_loss_percent)"
    ];
  },

  /* ---- freshness ------------------------------------------------------ */

  scrapeAge: function () {
    return [
      "time() - max(meraki_last_successful_collection_timestamp_seconds)",
      "time() - max(vmanage_last_successful_collection_timestamp_seconds)"
    ];
  }
};

/* ──────────────────────────────────────────────── range candidate ladders */

var RANGE = {
  rx: function (s) {
    return [
      "sum(wan_link_rx_bits_per_second" + s + ")",
      "sum(vmanage_wan_link_rx_bits_per_second" + s + ")",
      "sum(vmanage_interface_rx_bits_per_second" +
        (s ? s.slice(0, -1) + ',vpn_id="0"}' : '{vpn_id="0"}') + ")",
      "sum(meraki_uplink_received_bytes_per_second) * 8"
    ];
  },
  tx: function (s) {
    return [
      "sum(wan_link_tx_bits_per_second" + s + ")",
      "sum(vmanage_wan_link_tx_bits_per_second" + s + ")",
      "sum(vmanage_interface_tx_bits_per_second" +
        (s ? s.slice(0, -1) + ',vpn_id="0"}' : '{vpn_id="0"}') + ")",
      "sum(meraki_uplink_sent_bytes_per_second) * 8"
    ];
  },
  availability: function (s) {
    return [
      "avg(site_health_percent" + s + ")",
      "100 * sum(site_devices_up:all" + s + ") / clamp_min(sum(site_devices_total:all" + s + "), 1)"
    ];
  },
  utilization: function (s) {
    return [
      "avg(wan_link_utilization_percent" + s + ")",
      "max(wan_link_utilization_percent" + s + ")"
    ];
  }
};

/* ────────────────────────────────────────────────────── per-site families */

/** Per-site rollups, used by the DC panel and the site tables. */
var PER_SITE = {
  total: function (s) {
    return [
      "site_devices_total:all" + s,
      "sum by (region, country, site_id, priority) (device_info" + s + ")",
      "vmanage_site_devices_total" + s
    ];
  },
  up: function (s) {
    return [
      "site_devices_up:all" + s,
      "vmanage_site_devices_reachable" + s,
      "meraki_site_devices_online" + s
    ];
  },
  health: function (s) {
    return ["site_health_percent" + s];
  },
  wanUp: function (s) {
    return [
      "sum by (region, country, site_id) (wan_link_up" + s + " == 1)",
      "sdwan_site_wan_links_up" + s,
      "vmanage_site_wan_links_up" + s
    ];
  },
  wanTotal: function (s) {
    return [
      "count by (region, country, site_id) (wan_link_up" + s + ")",
      "sdwan_site_wan_links_total" + s,
      "vmanage_site_wan_links_total" + s
    ];
  },
  bfdUp: function (s) {
    var o = s ? s.slice(0, -1) + ',protocol="bfd"}' : '{protocol="bfd"}';
    return [
      "overlay_sessions_up" + o,
      "sum by (region, country, site_id) (vmanage_bfd_sessions_up" + s + ")"
    ];
  },
  bfdTotal: function (s) {
    var o = s ? s.slice(0, -1) + ',protocol="bfd"}' : '{protocol="bfd"}';
    return [
      "overlay_sessions_total" + o,
      "sum by (region, country, site_id) (vmanage_bfd_sessions_total" + s + ")"
    ];
  },
  latency: function (s) {
    return [
      "avg by (site_id) (wan_link_latency_milliseconds" + s + ")",
      "avg by (site_id) (vmanage_bfd_session_latency_ms" + s + ")"
    ];
  },
  loss: function (s) {
    return [
      "avg by (site_id) (wan_link_loss_percent" + s + ")",
      "avg by (site_id) (vmanage_bfd_session_loss_percent" + s + ")"
    ];
  },
  uptime: function (s) {
    return [
      "min by (site_id) (vmanage_device_uptime_seconds" + s + ")"
    ];
  }
};

/**
 * Probe set for the diagnostics endpoint. Ordered so the output reads as a
 * layer report: unified namespace first, then vendor rollups, then raw.
 */
var PROBES = [
  ["UNIFIED device_info",              "count(device_info%s)"],
  ["UNIFIED site_devices_total:all",   "count(site_devices_total:all%s)"],
  ["UNIFIED site_devices_up:all",      "count(site_devices_up:all%s)"],
  ["UNIFIED site_health_percent",      "count(site_health_percent%s)"],
  ["UNIFIED wan_link_up",              "count(wan_link_up%s)"],
  ["UNIFIED wan_link_rx_bits_per_second", "count(wan_link_rx_bits_per_second%s)"],
  ["UNIFIED wan_link_tx_bits_per_second", "count(wan_link_tx_bits_per_second%s)"],
  ["UNIFIED wan_link_utilization_percent", "count(wan_link_utilization_percent%s)"],
  ["UNIFIED overlay_sessions_up",      'count(overlay_sessions_up%s)'],
  ["SDWAN sdwan_site_wan_links_up",    "count(sdwan_site_wan_links_up%s)"],
  ["SDWAN wan_link_latency_milliseconds", "count(wan_link_latency_milliseconds%s)"],
  ["VMANAGE vmanage_device_reachable", "count(vmanage_device_reachable%s)"],
  ["VMANAGE vmanage_site_devices_total", "count(vmanage_site_devices_total%s)"],
  ["VMANAGE vmanage_bfd_sessions_up",  "count(vmanage_bfd_sessions_up%s)"],
  ["VMANAGE vmanage_wan_links_up",     "count(vmanage_wan_links_up%s)"],
  ["VMANAGE vmanage_exporter_up",      "count(vmanage_exporter_up)"],
  ["MERAKI meraki_device_up",          "count(meraki_device_up)"],
  ["MERAKI meraki_site_devices_total", "count(meraki_site_devices_total)"],
  ["MERAKI meraki_site_devices_online","count(meraki_site_devices_online)"],
  ["MERAKI meraki_uplink_status",      "count(meraki_uplink_status)"],
  ["MERAKI meraki_uplink_received_bytes_per_second", "count(meraki_uplink_received_bytes_per_second)"],
  ["MERAKI meraki_exporter_up",        "count(meraki_exporter_up)"],
  ["ABSENT meraki_uplink_util_percent","count(meraki_uplink_util_percent)"]
];

module.exports = { esc: esc, sel: sel, bare: bare, INSTANT: INSTANT, RANGE: RANGE, PER_SITE: PER_SITE, PROBES: PROBES };
