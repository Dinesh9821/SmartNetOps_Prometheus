"use strict";

const {
  PrometheusClient,
  samples,
  scalarFrom,
  maxFrom,
  avgFrom,
  latestTsFromResults,
  isoFromUnix
} = require("./prometheusClient");

// Grafana WAN dashboard (wan-dashboard.json Peak Utilisation):
// green < 60, yellow 60, orange 80, red 95.
// WAN "links over 80%" panel: count(wan_link_utilization_percent > 80)
const THRESHOLDS = {
  wanUtilWarning: 60,
  wanUtilHigh: 80,
  wanUtilCritical: 95
};

const SITE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/;

function extractSiteId(raw) {
  if (raw == null) return "";
  return String(raw).split("|")[0].trim();
}

function validateSiteId(raw) {
  const siteId = extractSiteId(raw);
  if (!siteId) return { ok: false, error: "Invalid or unknown Site ID" };
  if (!SITE_ID_RE.test(siteId)) return { ok: false, error: "Invalid or unknown Site ID" };
  return { ok: true, siteId };
}

function escapeLabel(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function siteSel(siteId) {
  return `site_id="${escapeLabel(siteId)}"`;
}

function merakiAtSite(metric, siteId) {
  // Uplink gauges have no site_id. Join through serial onto devices at the site.
  // group_left avoids many-to-many failures when a serial has several uplinks.
  return `max by (serial, uplink, network) (${metric}) ` +
    `and on (serial) group_left () (max by (serial) (meraki_device_up{${siteSel(siteId)}}))`;
}

function num(v, digits) {
  if (v == null || !Number.isFinite(v)) return null;
  if (digits == null) return v;
  return Number(v.toFixed(digits));
}

function bpsPretty(v) {
  if (v == null) return null;
  const abs = Math.abs(v);
  if (abs >= 1e9) return `${(v / 1e9).toFixed(2)} Gbps`;
  if (abs >= 1e6) return `${(v / 1e6).toFixed(2)} Mbps`;
  if (abs >= 1e3) return `${(v / 1e3).toFixed(2)} Kbps`;
  return `${v.toFixed(0)} bps`;
}

function secondsPretty(v) {
  if (v == null || !Number.isFinite(v)) return null;
  const s = Math.floor(v);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function keyOf(metric, fields) {
  return fields.map((f) => metric[f] || "").join("|");
}

function indexBy(result, fields) {
  const map = new Map();
  samples(result).forEach((s) => {
    map.set(keyOf(s.metric, fields), s);
  });
  return map;
}

function wanStatusFrom(up, util, admin) {
  if (admin === 0) return "ADMIN_DOWN";
  if (up == null) return "UNKNOWN";
  if (up === 0) return "DOWN";
  if (up === 0.5) return "DEGRADED";
  if (util != null && util >= THRESHOLDS.wanUtilHigh) return "DEGRADED";
  if (up === 1) return "UP";
  return up > 0 ? "UP" : "DOWN";
}

function deviceStatusFrom(value, statusLabel) {
  if (statusLabel) {
    const s = String(statusLabel).toLowerCase();
    if (s === "online") return "UP";
    if (s === "alerting") return "DEGRADED";
    if (s === "offline" || s === "dormant") return "DOWN";
  }
  if (value == null) return "UNKNOWN";
  if (value >= 1) return "UP";
  if (value >= 0.5) return "DEGRADED";
  if (value >= 0) return "DOWN";
  return "UNKNOWN";
}

function ospfTone(state) {
  const s = String(state || "").toLowerCase();
  if (s === "full" || s === "2-way" || s === "2way") return "healthy";
  if (["down", "init", "exstart", "exchange", "loading"].includes(s)) return "problem";
  return "unknown";
}

function bgpTone(state) {
  const s = String(state || "").toLowerCase();
  if (s === "established") return "healthy";
  return s ? "problem" : "unknown";
}

function issue(severity, section, title, detail) {
  return { severity, section, title, detail: detail || "" };
}

function snapshotQueries(siteId) {
  const s = siteSel(siteId);
  return {
    siteHealth: `site_health_percent{${s}}`,
    devicesTotalAll: `site_devices_total:all{${s}}`,
    devicesUpAll: `site_devices_up:all{${s}}`,
    deviceInfo: `device_info{${s}}`,

    wanUp: `wan_link_up{${s}}`,
    wanRx: `wan_link_rx_bits_per_second{${s}}`,
    wanTx: `wan_link_tx_bits_per_second{${s}}`,
    wanUtil: `wan_link_utilization_percent{${s}}`,
    wanCap: `wan_link_capacity_bits_per_second{${s}}`,
    wanSiteTotal: `vmanage_site_wan_links_total{${s}}`,
    wanSiteUp: `vmanage_site_wan_links_up{${s}}`,
    wanInfo: `vmanage_wan_link_info{${s}}`,
    wanAdmin: `wan_link_admin_up{${s}}`,
    vmanageWanAdmin: `vmanage_wan_link_admin_up{${s}}`,
    wanLatency: `vmanage_wan_link_latency_ms{${s}}`,
    wanJitter: `vmanage_wan_link_jitter_ms{${s}}`,
    wanLoss: `vmanage_wan_link_loss_percent{${s}}`,
    wanLatencyRec: `wan_link_latency_milliseconds{${s}}`,
    wanJitterRec: `wan_link_jitter_milliseconds{${s}}`,
    wanLossRec: `wan_link_loss_percent{${s}}`,
    wanRxDrops: `vmanage_wan_link_rx_drops{${s}}`,
    wanTxDrops: `vmanage_wan_link_tx_drops{${s}}`,
    bfdLatByColor: `avg by (hostname, local_color) (vmanage_bfd_session_latency_ms{${s}})`,
    bfdLossByColor: `avg by (hostname, local_color) (vmanage_bfd_session_loss_percent{${s}})`,
    bfdJitByColor: `avg by (hostname, local_color) (vmanage_bfd_session_jitter_ms{${s}})`,
    defaultRoute: `vmanage_default_route_present{${s}}`,
    merakiLatency: merakiAtSite("meraki_uplink_latency_milliseconds", siteId),
    merakiLoss: merakiAtSite("meraki_uplink_loss_percent", siteId),
    merakiUplinkStatus: merakiAtSite("meraki_uplink_status", siteId),
    merakiUplinkInfo: merakiAtSite("meraki_uplink_status_info", siteId),
    merakiCapacity: `meraki_uplink_capacity_bits_per_second{${s}}`,

    ospfState: `vmanage_ospf_neighbor_state_info{${s}}`,
    ospfUp: `vmanage_ospf_neighbor_up{${s}}`,
    ospfUptime: `vmanage_ospf_neighbor_uptime_seconds{${s}}`,
    ospfTotal: `vmanage_ospf_neighbors_total{${s}}`,
    ospfUpCount: `vmanage_ospf_neighbors_up{${s}}`,
    protocolAvail: `vmanage_protocol_data_available`,

    bgpState: `vmanage_bgp_neighbor_state_info{${s}}`,
    bgpUp: `vmanage_bgp_neighbor_up{${s}}`,
    bgpPrefixes: `vmanage_bgp_prefixes_received{${s}}`,
    bgpTotal: `vmanage_bgp_neighbors_total{${s}}`,
    bgpUpCount: `vmanage_bgp_neighbors_up{${s}}`,

    merakiDeviceUp: `meraki_device_up{${s}}`,
    merakiStatus: `meraki_device_status_info{${s}}`,
    merakiMem: `meraki_device_memory_used_percent{${s}}`,
    merakiCpu: `meraki_device_cpu_load5{${s}}`,
    vmanageReach: `vmanage_device_reachable{${s}}`,
    vmanageUptime: `vmanage_device_uptime_seconds{${s}}`,
    vmanageState: `vmanage_device_state_info{${s}}`,

    ifOper: `vmanage_interface_oper_up{${s}}`,
    ifRx: `vmanage_interface_rx_bits_per_second{${s}}`,
    ifTx: `vmanage_interface_tx_bits_per_second{${s}}`,
    ifRxErr: `vmanage_interface_rx_errors{${s}}`,
    ifTxErr: `vmanage_interface_tx_errors{${s}}`,
    ifRxDrop: `vmanage_interface_rx_drops{${s}}`,
    ifTxDrop: `vmanage_interface_tx_drops{${s}}`,
    ifSpeed: `vmanage_interface_speed_bits_per_second{${s}}`,

    merakiByRole: `meraki_site_devices_by_role{${s}}`,
    merakiSiteTotal: `meraki_site_devices_total{${s}}`,
    merakiSiteOnline: `meraki_site_devices_online{${s}}`,
    merakiClients: `meraki_switch_client_count{${s}}`,
    merakiPortErr: `meraki_switch_ports_with_errors{${s}}`,
    merakiPortWarn: `meraki_switch_ports_with_warnings{${s}}`,
    merakiPortsTotal: `meraki_switch_ports_total{${s}}`,
    merakiPortsConnected: `meraki_switch_ports_connected{${s}}`,
    merakiPoe: `meraki_switch_poe_draw_watts{${s}}`,
    merakiApUtil: `meraki_ap_channel_utilization_percent{${s}}`,
    merakiApWifi: `meraki_ap_channel_utilization_wifi_percent{${s}}`,
    merakiApNonWifi: `meraki_ap_channel_utilization_non_wifi_percent{${s}}`,

    bfdTotal: `vmanage_bfd_sessions_total{${s}}`,
    bfdUp: `vmanage_bfd_sessions_up{${s}}`,
    bfdSession: `vmanage_bfd_session_up{${s}}`,
    bfdUptime: `vmanage_bfd_session_uptime_seconds{${s}}`,
    bfdLatency: `vmanage_bfd_session_latency_ms{${s}}`,
    bfdLoss: `vmanage_bfd_session_loss_percent{${s}}`,
    bfdJitter: `vmanage_bfd_session_jitter_ms{${s}}`,
    ompTotal: `vmanage_omp_peers_total{${s}}`,
    ompUp: `vmanage_omp_peers_up{${s}}`,
    ompState: `vmanage_omp_peer_state_info{${s}}`,
    ompRoutesRx: `vmanage_omp_routes_received{${s}}`,
    ompRoutesInst: `vmanage_omp_routes_installed{${s}}`,
    ompRoutesSent: `vmanage_omp_routes_sent{${s}}`,
    controlUp: `vmanage_control_connections_up{${s}}`,
    overlayUp: `overlay_sessions_up{${s}}`,
    overlayTotal: `overlay_sessions_total{${s}}`
  };
}

function sectionFrom(q, names) {
  const listed = names.filter((n) => q[n]);
  if (!listed.length) return { available: false, reason: "No Data" };
  const anyOk = listed.some((n) => q[n].ok);
  const anySeries = listed.some((n) => q[n].ok && (q[n].result || []).length);
  if (!anyOk) return { available: false, reason: q[listed[0]].error || "No Data" };
  if (!anySeries) return { available: false, reason: "No Data" };
  return { available: true, reason: "Available" };
}

function buildWan(q) {
  const availability = sectionFrom(q, ["wanUp", "wanRx", "wanTx", "wanUtil", "merakiUplinkStatus"]);
  const links = new Map();

  function rowKeysFrom(metric) {
    metric = metric || {};
    const device = metric.device || metric.hostname || metric.network || metric.device_name || "";
    const link = metric.link || metric.uplink || metric.ifname || "";
    const serial = metric.serial || "";
    const keys = [];
    if (serial && (metric.uplink || link)) keys.push("s:" + serial + "|" + (metric.uplink || link));
    if (device && link) keys.push("d:" + device + "|" + link);
    return { device, link, serial, keys };
  }

  function ensure(metric, extra) {
    extra = extra || {};
    metric = Object.assign({}, extra, metric || {});
    const info = rowKeysFrom(metric);
    let row = null;
    info.keys.forEach((k) => {
      if (!row && links.has(k)) row = links.get(k);
    });
    if (!row) {
      row = {
        device: info.device,
        link: info.link,
        source: metric.source || extra.source || "",
        provider: metric.provider || null,
        circuit: metric.circuit_id || metric.circuit || null,
        interface: metric.ifname || metric.link || metric.uplink || null,
        transport: metric.transport || metric.color || metric.local_color || null,
        status: "UNKNOWN",
        up: null,
        admin_up: null,
        rx_bps: null,
        tx_bps: null,
        utilization: null,
        bandwidth_bps: null,
        latency_ms: null,
        jitter_ms: null,
        loss_percent: null,
        rx_drops: null,
        tx_drops: null,
        role: metric.role || null,
        ip: metric.ip || null,
        serial: info.serial || null
      };
    }
    info.keys.forEach((k) => { links.set(k, row); });
    if (!row.source && (metric.source || extra.source)) row.source = metric.source || extra.source;
    if (!row.device && info.device) row.device = info.device;
    if (!row.link && info.link) row.link = info.link;
    if (!row.serial && info.serial) row.serial = info.serial;
    if (!row.transport && (metric.transport || metric.color || metric.local_color)) {
      row.transport = metric.transport || metric.color || metric.local_color;
    }
    return row;
  }

  samples(q.wanUp && q.wanUp.result).forEach((s) => {
    const row = ensure(s.metric, {});
    row.up = s.value;
  });
  samples(q.wanRx && q.wanRx.result).forEach((s) => { ensure(s.metric).rx_bps = s.value; });
  samples(q.wanTx && q.wanTx.result).forEach((s) => { ensure(s.metric).tx_bps = s.value; });
  samples(q.wanUtil && q.wanUtil.result).forEach((s) => { ensure(s.metric).utilization = s.value; });
  samples(q.wanCap && q.wanCap.result).forEach((s) => { ensure(s.metric).bandwidth_bps = s.value; });
  samples(q.wanInfo && q.wanInfo.result).forEach((s) => {
    const row = ensure(s.metric);
    row.provider = s.metric.provider || row.provider;
    row.circuit = s.metric.circuit_id || row.circuit;
    row.transport = s.metric.transport || row.transport;
    row.role = s.metric.role || row.role;
    row.ip = s.metric.ip || row.ip;
    row.interface = s.metric.vpn_id ? `${row.interface || s.metric.link}` : row.interface;
  });
  function applyAdmin(s) {
    const row = ensure(Object.assign({}, s.metric, {
      device: s.metric.device || s.metric.hostname
    }));
    row.admin_up = s.value;
  }
  samples(q.wanAdmin && q.wanAdmin.result).forEach(applyAdmin);
  samples(q.vmanageWanAdmin && q.vmanageWanAdmin.result).forEach(applyAdmin);
  samples(q.wanLatency && q.wanLatency.result).forEach((s) => { ensure(s.metric).latency_ms = s.value; });
  samples(q.wanJitter && q.wanJitter.result).forEach((s) => { ensure(s.metric).jitter_ms = s.value; });
  samples(q.wanLoss && q.wanLoss.result).forEach((s) => { ensure(s.metric).loss_percent = s.value; });
  samples(q.wanLatencyRec && q.wanLatencyRec.result).forEach((s) => {
    const row = ensure(s.metric);
    if (row.latency_ms == null) row.latency_ms = s.value;
  });
  samples(q.wanJitterRec && q.wanJitterRec.result).forEach((s) => {
    const row = ensure(s.metric);
    if (row.jitter_ms == null) row.jitter_ms = s.value;
  });
  samples(q.wanLossRec && q.wanLossRec.result).forEach((s) => {
    const row = ensure(s.metric);
    if (row.loss_percent == null) row.loss_percent = s.value;
  });
  samples(q.wanRxDrops && q.wanRxDrops.result).forEach((s) => { ensure(s.metric).rx_drops = s.value; });
  samples(q.wanTxDrops && q.wanTxDrops.result).forEach((s) => { ensure(s.metric).tx_drops = s.value; });

  samples(q.merakiUplinkStatus && q.merakiUplinkStatus.result).forEach((s) => {
    const m = Object.assign({}, s.metric, {
      device: s.metric.network,
      link: s.metric.uplink,
      source: "meraki"
    });
    const row = ensure(m);
    if (row.up == null) row.up = s.value;
  });
  samples(q.merakiUplinkInfo && q.merakiUplinkInfo.result).forEach((s) => {
    const m = Object.assign({}, s.metric, {
      device: s.metric.network,
      link: s.metric.uplink,
      source: "meraki"
    });
    const row = ensure(m);
    row.meraki_status = s.metric.status;
  });
  samples(q.merakiLatency && q.merakiLatency.result).forEach((s) => {
    const row = ensure({
      network: s.metric.network,
      uplink: s.metric.uplink,
      serial: s.metric.serial,
      source: "meraki"
    });
    if (row.latency_ms == null) row.latency_ms = s.value;
  });
  samples(q.merakiLoss && q.merakiLoss.result).forEach((s) => {
    const row = ensure({
      network: s.metric.network,
      uplink: s.metric.uplink,
      serial: s.metric.serial,
      source: "meraki"
    });
    if (row.loss_percent == null) row.loss_percent = s.value;
  });
  samples(q.merakiCapacity && q.merakiCapacity.result).forEach((s) => {
    const row = ensure({
      serial: s.metric.serial,
      uplink: s.metric.uplink,
      link: s.metric.uplink,
      source: "meraki",
      provider: s.metric.provider,
      circuit_id: s.metric.circuit_id
    });
    if (row.bandwidth_bps == null) row.bandwidth_bps = s.value;
    row.provider = row.provider || s.metric.provider;
    row.circuit = row.circuit || s.metric.circuit_id;
  });

  function applyBfdQuality(result, field) {
    samples(result).forEach((s) => {
      const host = s.metric.hostname;
      const color = s.metric.local_color;
      Array.from(new Set(links.values())).forEach((row) => {
        if (row[field] != null) return;
        if (row.device !== host && row.serial !== host) return;
        if (color && row.transport && row.transport !== color && row.link !== color) return;
        row[field] = s.value;
      });
    });
  }
  applyBfdQuality(q.bfdLatByColor && q.bfdLatByColor.result, "latency_ms");
  applyBfdQuality(q.bfdJitByColor && q.bfdJitByColor.result, "jitter_ms");
  applyBfdQuality(q.bfdLossByColor && q.bfdLossByColor.result, "loss_percent");

  const rows = Array.from(new Set(links.values())).map((r) => {
    r.status = wanStatusFrom(r.up, r.utilization, r.admin_up);
    r.admin = r.admin_up == null ? null : (r.admin_up === 1 ? "UP" : "DOWN");
    r.oper = r.up == null ? null : (r.up >= 1 ? "UP" : (r.up === 0.5 ? "DEGRADED" : "DOWN"));
    r.rx = bpsPretty(r.rx_bps);
    r.tx = bpsPretty(r.tx_bps);
    r.bandwidth = bpsPretty(r.bandwidth_bps);
    r.utilization = num(r.utilization, 1);
    r.latency_ms = num(r.latency_ms, 1);
    r.jitter_ms = num(r.jitter_ms, 1);
    r.loss_percent = num(r.loss_percent, 2);
    r.rx_drops = r.rx_drops == null ? null : r.rx_drops;
    r.tx_drops = r.tx_drops == null ? null : r.tx_drops;
    r.drops = (r.rx_drops == null && r.tx_drops == null)
      ? null
      : (r.rx_drops || 0) + (r.tx_drops || 0);
    return r;
  });

  const total = rows.length || scalarFrom(q.wanSiteTotal && q.wanSiteTotal.result) || 0;
  const active = rows.filter((r) => r.status === "UP").length
    || scalarFrom(q.wanSiteUp && q.wanSiteUp.result)
    || 0;
  const adminDown = rows.filter((r) => r.status === "ADMIN_DOWN").length;
  const down = rows.filter((r) => r.status === "DOWN").length;
  const utils = rows.map((r) => r.utilization).filter((v) => v != null);
  const avgUtil = utils.length ? utils.reduce((a, b) => a + b, 0) / utils.length : null;

  return {
    availability,
    total: Number(total) || rows.length,
    active,
    down,
    admin_down: adminDown,
    average_utilization: num(avgUtil, 1),
    links: rows
  };
}

function buildOspf(q) {
  const protocol = samples(q.protocolAvail && q.protocolAvail.result)
    .find((s) => String(s.metric.protocol || "").toLowerCase() === "ospf");
  const availability = sectionFrom(q, ["ospfState", "ospfUp", "ospfTotal"]);
  if (protocol && protocol.value === 0) {
    return {
      availability: { available: false, reason: "No Data" },
      neighbors: 0,
      established: 0,
      down: 0,
      rows: [],
      protocol_available: false
    };
  }

  const upIdx = indexBy(q.ospfUp && q.ospfUp.result, ["hostname", "neighbor_id", "ifname", "vpn_id"]);
  const uptimeIdx = indexBy(q.ospfUptime && q.ospfUptime.result, ["hostname", "neighbor_id", "ifname", "vpn_id"]);
  const rows = samples(q.ospfState && q.ospfState.result).map((s) => {
    const k = keyOf(s.metric, ["hostname", "neighbor_id", "ifname", "vpn_id"]);
    const up = upIdx.get(k);
    const ut = uptimeIdx.get(k);
    const state = s.metric.state || (up && up.value === 1 ? "full" : "down");
    return {
      device: s.metric.hostname || s.metric.device,
      interface: s.metric.ifname,
      neighbor: s.metric.neighbor_id,
      area: s.metric.area_id,
      vpn_id: s.metric.vpn_id,
      state,
      tone: ospfTone(state),
      uptime: secondsPretty(ut && ut.value),
      uptime_seconds: ut ? ut.value : null
    };
  });

  const neighbors = rows.length || scalarFrom(q.ospfTotal && q.ospfTotal.result) || 0;
  const established = rows.filter((r) => r.tone === "healthy").length
    || scalarFrom(q.ospfUpCount && q.ospfUpCount.result)
    || 0;
  return {
    availability: rows.length || neighbors ? availability : { available: false, reason: "No Data" },
    neighbors: Number(neighbors) || rows.length,
    established,
    down: Math.max((Number(neighbors) || rows.length) - established, 0),
    rows,
    protocol_available: protocol ? protocol.value === 1 : rows.length > 0
  };
}

function buildBgp(q) {
  const protocol = samples(q.protocolAvail && q.protocolAvail.result)
    .find((s) => String(s.metric.protocol || "").toLowerCase() === "bgp");
  const availability = sectionFrom(q, ["bgpState", "bgpUp", "bgpTotal"]);
  if (protocol && protocol.value === 0 && !(q.bgpState && q.bgpState.result && q.bgpState.result.length)) {
    return {
      availability: { available: false, reason: "No Data" },
      peers: 0,
      established: 0,
      down: 0,
      rows: [],
      protocol_available: false
    };
  }

  const upIdx = indexBy(q.bgpUp && q.bgpUp.result, ["hostname", "peer_addr", "vpn_id"]);
  const pfxIdx = indexBy(q.bgpPrefixes && q.bgpPrefixes.result, ["hostname", "peer_addr", "vpn_id"]);
  const rows = samples(q.bgpState && q.bgpState.result).map((s) => {
    const k = keyOf(s.metric, ["hostname", "peer_addr", "vpn_id"]);
    const up = upIdx.get(k);
    const pfx = pfxIdx.get(k);
    const state = s.metric.state || (up && up.value === 1 ? "established" : "idle");
    return {
      device: s.metric.hostname,
      peer: s.metric.peer_addr,
      asn: s.metric.remote_as,
      vpn_id: s.metric.vpn_id,
      state,
      tone: bgpTone(state),
      prefixes: pfx ? pfx.value : null,
      uptime: null
    };
  });

  const peers = rows.length || scalarFrom(q.bgpTotal && q.bgpTotal.result) || 0;
  const established = rows.filter((r) => r.tone === "healthy").length
    || scalarFrom(q.bgpUpCount && q.bgpUpCount.result)
    || 0;
  return {
    availability: rows.length || peers ? availability : { available: false, reason: "No Data" },
    peers: Number(peers) || rows.length,
    established,
    down: Math.max((Number(peers) || rows.length) - established, 0),
    rows,
    protocol_available: protocol ? protocol.value === 1 : rows.length > 0
  };
}

function buildDevices(q) {
  const availability = sectionFrom(q, ["deviceInfo", "merakiDeviceUp", "vmanageReach"]);
  const rows = new Map();

  function ensure(id, metric) {
    if (!rows.has(id)) {
      rows.set(id, {
        device: metric.device || metric.device_name || metric.hostname || id,
        type: metric.type || metric.product_type || metric.device_type || metric.role || metric.device_role || null,
        ip: metric.ident || metric.system_ip || null,
        source: metric.source || null,
        status: "UNKNOWN",
        cpu: null,
        memory: null,
        uptime: null,
        role: metric.role || metric.device_role || null,
        model: metric.model || metric.device_model || null
      });
    }
    return rows.get(id);
  }

  samples(q.deviceInfo && q.deviceInfo.result).forEach((s) => {
    const id = s.metric.ident || s.metric.device;
    const row = ensure(id, s.metric);
    row.status = deviceStatusFrom(s.value);
    row.source = s.metric.source || row.source;
    row.type = s.metric.type || s.metric.role || row.type;
    row.ip = s.metric.ident || row.ip;
    row.model = s.metric.model || row.model;
  });
  samples(q.merakiDeviceUp && q.merakiDeviceUp.result).forEach((s) => {
    const row = ensure(s.metric.serial, s.metric);
    row.device = s.metric.device_name || row.device;
    row.type = s.metric.product_type || s.metric.device_role || row.type;
    row.ip = s.metric.serial;
    row.source = "meraki";
    row.status = deviceStatusFrom(s.value);
  });
  samples(q.merakiStatus && q.merakiStatus.result).forEach((s) => {
    const row = ensure(s.metric.serial, s.metric);
    row.status = deviceStatusFrom(null, s.metric.status);
  });
  samples(q.merakiMem && q.merakiMem.result).forEach((s) => {
    const row = ensure(s.metric.serial, s.metric);
    row.memory = num(s.value, 1);
  });
  samples(q.merakiCpu && q.merakiCpu.result).forEach((s) => {
    const row = ensure(s.metric.serial, s.metric);
    row.cpu = num(s.value, 2);
  });
  samples(q.vmanageReach && q.vmanageReach.result).forEach((s) => {
    const id = s.metric.system_ip || s.metric.hostname;
    const row = ensure(id, s.metric);
    row.device = s.metric.hostname || row.device;
    row.type = s.metric.device_type || s.metric.device_role || row.type;
    row.ip = s.metric.system_ip;
    row.source = "vmanage";
    row.status = deviceStatusFrom(s.value);
  });
  samples(q.vmanageUptime && q.vmanageUptime.result).forEach((s) => {
    const id = s.metric.system_ip || s.metric.hostname;
    const row = ensure(id, s.metric);
    row.uptime = secondsPretty(s.value);
    row.uptime_seconds = s.value;
  });

  const list = Array.from(rows.values());
  const total = list.length || scalarFrom(q.devicesTotalAll && q.devicesTotalAll.result) || 0;
  const online = list.filter((r) => r.status === "UP").length
    || scalarFrom(q.devicesUpAll && q.devicesUpAll.result)
    || 0;
  const offline = list.filter((r) => r.status === "DOWN").length;
  return {
    availability: list.length || total ? availability : { available: false, reason: "No Data" },
    total: Number(total) || list.length,
    online,
    offline,
    degraded: list.filter((r) => r.status === "DEGRADED").length,
    health_percent: num(scalarFrom(q.siteHealth && q.siteHealth.result), 1),
    rows: list
  };
}

function buildInterfaces(q) {
  const availability = sectionFrom(q, ["ifOper"]);
  const keys = ["hostname", "ifname", "vpn_id"];
  const oper = samples(q.ifOper && q.ifOper.result);
  const rx = indexBy(q.ifRx && q.ifRx.result, keys);
  const tx = indexBy(q.ifTx && q.ifTx.result, keys);
  const rxE = indexBy(q.ifRxErr && q.ifRxErr.result, keys);
  const txE = indexBy(q.ifTxErr && q.ifTxErr.result, keys);
  const rxD = indexBy(q.ifRxDrop && q.ifRxDrop.result, keys);
  const txD = indexBy(q.ifTxDrop && q.ifTxDrop.result, keys);
  const spd = indexBy(q.ifSpeed && q.ifSpeed.result, keys);

  const rows = oper.map((s) => {
    const k = keyOf(s.metric, keys);
    const errors = (rxE.get(k)?.value || 0) + (txE.get(k)?.value || 0);
    const discards = (rxD.get(k)?.value || 0) + (txD.get(k)?.value || 0);
    const rxBps = rx.get(k)?.value;
    const txBps = tx.get(k)?.value;
    const speed = spd.get(k)?.value;
    let util = null;
    if (speed && speed > 0 && (rxBps != null || txBps != null)) {
      util = 100 * Math.max(rxBps || 0, txBps || 0) / speed;
    }
    return {
      device: s.metric.hostname,
      interface: s.metric.ifname,
      description: s.metric.color && s.metric.color !== "none" ? s.metric.color : (s.metric.vpn_id != null ? `VPN ${s.metric.vpn_id}` : null),
      status: s.value === 1 ? "UP" : "DOWN",
      rx: bpsPretty(rxBps),
      tx: bpsPretty(txBps),
      errors,
      discards,
      speed: bpsPretty(speed),
      utilization: num(util, 1)
    };
  });

  const total = rows.length;
  const up = rows.filter((r) => r.status === "UP").length;
  const down = rows.filter((r) => r.status === "DOWN").length;
  const errorSum = rows.reduce((a, r) => a + (r.errors || 0), 0);
  const discardSum = rows.reduce((a, r) => a + (r.discards || 0), 0);
  return {
    availability: total ? availability : { available: false, reason: "No Data" },
    total,
    up,
    down,
    errors: errorSum,
    discards: discardSum,
    rows: rows.slice(0, 400)
  };
}

function buildDefaultRoutes(q) {
  const availability = sectionFrom(q, ["defaultRoute"]);
  const rows = samples(q.defaultRoute && q.defaultRoute.result).map((s) => ({
    device: s.metric.hostname,
    vpn_id: s.metric.vpn_id,
    present: s.value === 1,
    status: s.value === 1 ? "PRESENT" : "MISSING"
  }));
  const missing = rows.filter((r) => !r.present);
  return {
    availability: rows.length ? availability : { available: false, reason: "No Data" },
    total: rows.length,
    present: rows.length - missing.length,
    missing: missing.length,
    rows
  };
}

function buildMeraki(q) {
  const availability = sectionFrom(q, ["merakiSiteTotal", "merakiDeviceUp", "merakiByRole"]);
  const byRole = {};
  samples(q.merakiByRole && q.merakiByRole.result).forEach((s) => {
    const role = s.metric.device_role || s.metric.product_type || "other";
    byRole[role] = (byRole[role] || 0) + s.value;
  });
  const byType = {};
  samples(q.merakiDeviceUp && q.merakiDeviceUp.result).forEach((s) => {
    const t = s.metric.product_type || "unknown";
    if (!byType[t]) byType[t] = { total: 0, up: 0 };
    byType[t].total += 1;
    if (s.value >= 1) byType[t].up += 1;
  });
  const clients = scalarFrom(q.merakiClients && q.merakiClients.result);
  const portErr = scalarFrom(q.merakiPortErr && q.merakiPortErr.result);
  const portWarn = scalarFrom(q.merakiPortWarn && q.merakiPortWarn.result);
  const portsTotal = scalarFrom(q.merakiPortsTotal && q.merakiPortsTotal.result);
  const portsConnected = scalarFrom(q.merakiPortsConnected && q.merakiPortsConnected.result);
  const poe = scalarFrom(q.merakiPoe && q.merakiPoe.result);
  const apUtil = maxFrom(q.merakiApUtil && q.merakiApUtil.result);
  const apWifi = maxFrom(q.merakiApWifi && q.merakiApWifi.result);
  const apNonWifi = maxFrom(q.merakiApNonWifi && q.merakiApNonWifi.result);
  const total = scalarFrom(q.merakiSiteTotal && q.merakiSiteTotal.result);
  const online = scalarFrom(q.merakiSiteOnline && q.merakiSiteOnline.result);
  const uplinks = samples(q.merakiUplinkStatus && q.merakiUplinkStatus.result);
  const uplinkUp = uplinks.filter((s) => s.value >= 1).length;

  const switchKeys = ["device_name", "serial"];
  const swTotal = indexBy(q.merakiPortsTotal && q.merakiPortsTotal.result, switchKeys);
  const swConn = indexBy(q.merakiPortsConnected && q.merakiPortsConnected.result, switchKeys);
  const swErr = indexBy(q.merakiPortErr && q.merakiPortErr.result, switchKeys);
  const swWarn = indexBy(q.merakiPortWarn && q.merakiPortWarn.result, switchKeys);
  const swPoe = indexBy(q.merakiPoe && q.merakiPoe.result, switchKeys);
  const swCli = indexBy(q.merakiClients && q.merakiClients.result, switchKeys);
  const switchSeen = new Set([
    ...swTotal.keys(), ...swConn.keys(), ...swErr.keys(), ...swWarn.keys(), ...swPoe.keys()
  ]);
  const switches = Array.from(switchSeen).filter(Boolean).map((k) => {
    const sample = swTotal.get(k) || swConn.get(k) || swErr.get(k) || swPoe.get(k) || swCli.get(k);
    const m = (sample && sample.metric) || {};
    return {
      device: m.device_name,
      serial: m.serial,
      model: m.model,
      ports_total: swTotal.get(k) ? swTotal.get(k).value : null,
      ports_connected: swConn.get(k) ? swConn.get(k).value : null,
      errors: swErr.get(k) ? swErr.get(k).value : null,
      warnings: swWarn.get(k) ? swWarn.get(k).value : null,
      poe_watts: swPoe.get(k) ? num(swPoe.get(k).value, 1) : null,
      clients: swCli.get(k) ? swCli.get(k).value : null
    };
  });

  const aps = samples(q.merakiApUtil && q.merakiApUtil.result).map((s) => ({
    device: s.metric.device_name,
    serial: s.metric.serial,
    band: s.metric.band,
    util_percent: num(s.value, 1),
    wifi_percent: null,
    non_wifi_percent: null
  }));
  const wifiIdx = indexBy(q.merakiApWifi && q.merakiApWifi.result, ["device_name", "band", "serial"]);
  const nonIdx = indexBy(q.merakiApNonWifi && q.merakiApNonWifi.result, ["device_name", "band", "serial"]);
  aps.forEach((a) => {
    const k = [a.device, a.band, a.serial].join("|");
    const w = wifiIdx.get(k);
    const n = nonIdx.get(k);
    a.wifi_percent = w ? num(w.value, 1) : null;
    a.non_wifi_percent = n ? num(n.value, 1) : null;
  });

  return {
    availability: total || Object.keys(byType).length ? availability : { available: false, reason: "No Data" },
    total: total || Object.values(byType).reduce((a, x) => a + x.total, 0),
    online: online || Object.values(byType).reduce((a, x) => a + x.up, 0),
    by_role: byRole,
    by_product: byType,
    clients,
    switch_port_errors: portErr,
    switch_port_warnings: portWarn,
    switch_ports_total: portsTotal,
    switch_ports_connected: portsConnected,
    poe_watts: num(poe, 1),
    ap_channel_util_max: num(apUtil, 1),
    ap_wifi_util_max: num(apWifi, 1),
    ap_non_wifi_util_max: num(apNonWifi, 1),
    switches,
    access_points: aps,
    uplinks: { total: uplinks.length, active: uplinkUp, down: uplinks.filter((s) => s.value === 0).length }
  };
}

function buildSdwan(q) {
  const availability = sectionFrom(q, ["bfdTotal", "ompTotal", "controlUp", "vmanageReach"]);
  const overlay = {};
  samples(q.overlayUp && q.overlayUp.result).forEach((s) => {
    const p = s.metric.protocol || "unknown";
    overlay[p] = overlay[p] || { up: 0, total: 0 };
    overlay[p].up = s.value;
  });
  samples(q.overlayTotal && q.overlayTotal.result).forEach((s) => {
    const p = s.metric.protocol || "unknown";
    overlay[p] = overlay[p] || { up: 0, total: 0 };
    overlay[p].total = s.value;
  });

  const tunnels = samples(q.bfdSession && q.bfdSession.result).map((s) => ({
    device: s.metric.hostname,
    remote_system_ip: s.metric.remote_system_ip,
    remote_site_id: s.metric.remote_site_id,
    transport: s.metric.local_color,
    remote_color: s.metric.remote_color,
    proto: s.metric.proto,
    state: s.value === 1 ? "UP" : "DOWN"
  }));
  const bfdKey = ["hostname", "remote_system_ip", "local_color", "remote_color"];
  const lat = indexBy(q.bfdLatency && q.bfdLatency.result, bfdKey);
  const loss = indexBy(q.bfdLoss && q.bfdLoss.result, bfdKey);
  const jit = indexBy(q.bfdJitter && q.bfdJitter.result, bfdKey);
  const ut = indexBy(q.bfdUptime && q.bfdUptime.result, bfdKey);
  tunnels.forEach((t) => {
    const k = [t.device, t.remote_system_ip, t.transport, t.remote_color].join("|");
    const L = lat.get(k); const Lo = loss.get(k); const J = jit.get(k); const U = ut.get(k);
    t.latency_ms = L ? num(L.value, 1) : null;
    t.loss_percent = Lo ? num(Lo.value, 2) : null;
    t.jitter_ms = J ? num(J.value, 1) : null;
    t.uptime_seconds = U ? U.value : null;
    t.uptime = U ? secondsPretty(U.value) : null;
  });

  const rxIdx = indexBy(q.ompRoutesRx && q.ompRoutesRx.result, ["hostname", "peer"]);
  const instIdx = indexBy(q.ompRoutesInst && q.ompRoutesInst.result, ["hostname", "peer"]);
  const sentIdx = indexBy(q.ompRoutesSent && q.ompRoutesSent.result, ["hostname", "peer"]);
  const ompRows = samples(q.ompState && q.ompState.result).map((s) => {
    const k = keyOf(s.metric, ["hostname", "peer"]);
    const rx = rxIdx.get(k);
    const inst = instIdx.get(k);
    const sent = sentIdx.get(k);
    return {
      device: s.metric.hostname,
      peer: s.metric.peer,
      peer_type: s.metric.peer_type,
      state: s.metric.state,
      routes_received: rx ? rx.value : null,
      routes_installed: inst ? inst.value : null,
      routes_sent: sent ? sent.value : null
    };
  });

  const edges = samples(q.vmanageReach && q.vmanageReach.result)
    .filter((s) => String(s.metric.device_role || s.metric.device_type || "").toUpperCase().includes("ROUTER")
      || String(s.metric.hostname || "").match(/-RTR|-CE|-VEDGE|-CEDGE/i));

  return {
    availability: (scalarFrom(q.bfdTotal && q.bfdTotal.result) != null)
      || (scalarFrom(q.ompTotal && q.ompTotal.result) != null)
      || samples(q.vmanageReach && q.vmanageReach.result).length
      ? availability
      : { available: false, reason: "No Data" },
    wan_edges: edges.length || samples(q.vmanageReach && q.vmanageReach.result).length,
    bfd: {
      total: scalarFrom(q.bfdTotal && q.bfdTotal.result) || tunnels.length,
      up: scalarFrom(q.bfdUp && q.bfdUp.result) || tunnels.filter((t) => t.state === "UP").length
    },
    omp: {
      total: scalarFrom(q.ompTotal && q.ompTotal.result) || ompRows.length,
      up: scalarFrom(q.ompUp && q.ompUp.result) || ompRows.filter((r) => String(r.state).toLowerCase() === "up").length,
      rows: ompRows
    },
    control_connections_up: scalarFrom(q.controlUp && q.controlUp.result),
    overlay,
    tunnels: tunnels.slice(0, 200)
  };
}

function collectIssues(wan, ospf, bgp, devices, ifaces, meraki, sdwan, routes) {
  const issues = [];
  wan.links.forEach((l) => {
    const name = `${l.link || l.interface || "WAN"} on ${l.device || "device"}`;
    if (l.status === "ADMIN_DOWN") {
      issues.push(issue("WARNING", "wan", `${name} is administratively down`, "Port/circuit is shut; not an L1 outage"));
    } else if (l.status === "DOWN") {
      issues.push(issue("CRITICAL", "wan", `${name} is DOWN`, "WAN circuit operationally down"));
    } else if (l.utilization != null && l.utilization >= THRESHOLDS.wanUtilCritical) {
      issues.push(issue("CRITICAL", "wan", `${name} utilization ${l.utilization}%`, `Grafana threshold ${THRESHOLDS.wanUtilCritical}%`));
    } else if (l.utilization != null && l.utilization >= THRESHOLDS.wanUtilHigh) {
      issues.push(issue("WARNING", "wan", `${name} utilization ${l.utilization}%`, `Grafana threshold ${THRESHOLDS.wanUtilHigh}%`));
    } else if (l.utilization != null && l.utilization >= THRESHOLDS.wanUtilWarning) {
      issues.push(issue("INFO", "wan", `${name} utilization ${l.utilization}%`, `Grafana threshold ${THRESHOLDS.wanUtilWarning}%`));
    }
  });
  if (wan.total > 0 && wan.active === 0) {
    issues.push(issue("CRITICAL", "wan", "All WAN links are down", ""));
  }
  ospf.rows.forEach((r) => {
    if (r.tone === "problem") {
      const sev = String(r.state).toLowerCase() === "down" ? "CRITICAL" : "WARNING";
      issues.push(issue(sev, "ospf", `OSPF ${r.neighbor} on ${r.device} is ${String(r.state).toUpperCase()}`, r.interface || ""));
    }
  });
  bgp.rows.forEach((r) => {
    if (r.tone === "problem") {
      issues.push(issue("WARNING", "bgp", `BGP peer ${r.peer} is not established`, `${r.device} state=${r.state}`));
    }
  });
  if (bgp.peers > 0 && bgp.established === 0) {
    issues.push(issue("CRITICAL", "bgp", "All BGP peers are down", ""));
  }
  devices.rows.forEach((d) => {
    if (d.status === "DOWN") issues.push(issue("CRITICAL", "devices", `${d.device} is DOWN`, d.type || d.source || ""));
    if (d.status === "DEGRADED") issues.push(issue("WARNING", "devices", `${d.device} is alerting`, d.type || ""));
  });
  ifaces.rows.filter((r) => r.status === "DOWN").slice(0, 25).forEach((r) => {
    issues.push(issue("WARNING", "interfaces", `${r.device} ${r.interface} is DOWN`, ""));
  });
  ifaces.rows.filter((r) => r.utilization != null && r.utilization >= THRESHOLDS.wanUtilHigh).slice(0, 15).forEach((r) => {
    issues.push(issue("WARNING", "interfaces", `${r.device} ${r.interface} utilization ${r.utilization}%`, ""));
  });
  if (meraki.switch_port_errors && meraki.switch_port_errors > 0) {
    issues.push(issue("WARNING", "meraki", `${meraki.switch_port_errors} Meraki switch ports reporting errors`, ""));
  }
  if (meraki.switch_port_warnings && meraki.switch_port_warnings > 0) {
    issues.push(issue("INFO", "meraki", `${meraki.switch_port_warnings} Meraki switch ports reporting warnings`, ""));
  }
  if (sdwan.bfd.total > 0 && sdwan.bfd.up === 0) {
    issues.push(issue("CRITICAL", "sdwan", "All BFD sessions are down", ""));
  } else if (sdwan.bfd.total > 0 && sdwan.bfd.up < sdwan.bfd.total) {
    issues.push(issue("WARNING", "sdwan", `${sdwan.bfd.total - sdwan.bfd.up} BFD sessions down`, ""));
  }
  if (sdwan.omp.total > 0 && sdwan.omp.up === 0) {
    issues.push(issue("CRITICAL", "sdwan", "All OMP peers are down", ""));
  }
  (routes && routes.rows ? routes.rows : []).filter((r) => !r.present).forEach((r) => {
    const vpn = r.vpn_id == null ? "" : `VPN ${r.vpn_id}`;
    issues.push(issue("CRITICAL", "routes", `${r.device} default route missing ${vpn}`.trim(),
      "A missing 0.0.0.0/0 can black-hole the site while interfaces still read up"));
  });

  const rank = { CRITICAL: 0, WARNING: 1, INFO: 2 };
  issues.sort((a, b) => (rank[a.severity] - rank[b.severity]) || a.title.localeCompare(b.title));
  return issues;
}

function overallFrom(snapshot) {
  if (snapshot.prometheus_unavailable) return "UNKNOWN";
  const sections = [
    snapshot.wan, snapshot.ospf, snapshot.bgp, snapshot.devices,
    snapshot.interfaces, snapshot.meraki, snapshot.sdwan
  ];
  const anyData = sections.some((s) => s && s.availability && s.availability.available);
  if (!anyData) return "UNKNOWN";
  if (snapshot.issues.some((i) => i.severity === "CRITICAL")) return "CRITICAL";
  if (snapshot.issues.some((i) => i.severity === "WARNING")) return "WARNING";
  return "HEALTHY";
}

function emptySection(reason) {
  return { availability: { available: false, reason: reason || "No Data" } };
}

async function getSiteSnapshot(siteId, client) {
  const prom = client || new PrometheusClient();
  let queries;
  try {
    queries = await prom.queryMany(snapshotQueries(siteId), 8);
  } catch (err) {
    return {
      site_id: siteId,
      overall_status: "UNKNOWN",
      last_updated: new Date().toISOString(),
      scraped_at: null,
      prometheus_unavailable: true,
      error: "Monitoring data temporarily unavailable",
      devices: emptySection(),
      wan: emptySection(),
      ospf: emptySection(),
      bgp: emptySection(),
      hosts: {
        availability: {
          available: false,
          reason: "No dedicated ICMP/host Prometheus metrics in Network Telemetry"
        },
        total: 0, up: 0, down: 0, unknown: 0, rows: []
      },
      interfaces: emptySection(),
      meraki: emptySection(),
      sdwan: emptySection(),
      routes: emptySection(),
      issues: []
    };
  }

  const wan = buildWan(queries);
  const ospf = buildOspf(queries);
  const bgp = buildBgp(queries);
  const devices = buildDevices(queries);
  const interfaces = buildInterfaces(queries);
  const meraki = buildMeraki(queries);
  const sdwan = buildSdwan(queries);
  const routes = buildDefaultRoutes(queries);
  const issues = collectIssues(wan, ospf, bgp, devices, interfaces, meraki, sdwan, routes);

  const lastUpdated = new Date().toISOString();
  const scrapedAt = isoFromUnix(latestTsFromResults(queries)) || lastUpdated;
  const snapshot = {
    site_id: siteId,
    last_updated: lastUpdated,
    scraped_at: scrapedAt,
    prometheus_unavailable: false,
    thresholds: THRESHOLDS,
    devices,
    wan,
    ospf,
    bgp,
    hosts: {
      availability: {
        available: false,
        reason: "No dedicated ICMP/host Prometheus metrics exist in Network Telemetry. Device reachability is reported under Device Status."
      },
      total: 0,
      up: 0,
      down: 0,
      unknown: 0,
      rows: []
    },
    interfaces,
    meraki,
    sdwan,
    routes,
    issues,
    query_errors: Object.fromEntries(
      Object.entries(queries)
        .filter(([, v]) => !v.ok)
        .map(([k, v]) => [k, v.error])
    )
  };
  snapshot.overall_status = overallFrom(snapshot);
  const qvals = Object.values(queries);
  if (qvals.length && qvals.every((v) => !v.ok)) {
    snapshot.prometheus_unavailable = true;
    snapshot.error = "Monitoring data temporarily unavailable";
    snapshot.overall_status = "UNKNOWN";
  }
  return snapshot;
}

const RANGE_WINDOWS = {
  "15m": 15 * 60,
  "1h": 60 * 60,
  "6h": 6 * 60 * 60,
  "24h": 24 * 60 * 60
};

function rangeStep(seconds) {
  if (seconds <= 15 * 60) return 15;
  if (seconds <= 3600) return 30;
  if (seconds <= 6 * 3600) return 120;
  return 300;
}

async function getSiteSeries(siteId, rangeKey, client) {
  const prom = client || new PrometheusClient();
  const seconds = RANGE_WINDOWS[rangeKey] || RANGE_WINDOWS["1h"];
  const end = Math.floor(Date.now() / 1000);
  const start = end - seconds;
  const step = rangeStep(seconds);
  const s = siteSel(siteId);

  const charts = {
    wan_rx: `wan_link_rx_bits_per_second{${s}}`,
    wan_tx: `wan_link_tx_bits_per_second{${s}}`,
    wan_util: `avg(wan_link_utilization_percent{${s}})`,
    latency_rec: `avg(wan_link_latency_milliseconds{${s}})`,
    latency_vmanage: `avg(vmanage_wan_link_latency_ms{${s}})`,
    latency_bfd: `avg(vmanage_bfd_session_latency_ms{${s}})`,
    latency_meraki: `avg(${merakiAtSite("meraki_uplink_latency_milliseconds", siteId)})`,
    loss_rec: `avg(wan_link_loss_percent{${s}})`,
    loss_vmanage: `avg(vmanage_wan_link_loss_percent{${s}})`,
    loss_bfd: `avg(vmanage_bfd_session_loss_percent{${s}})`,
    loss_meraki: `avg(${merakiAtSite("meraki_uplink_loss_percent", siteId)})`,
    drops: `sum(vmanage_wan_link_rx_drops{${s}}) + sum(vmanage_wan_link_tx_drops{${s}})`,
    devices_up: `site_devices_up:all{${s}}`,
    devices_total: `site_devices_total:all{${s}}`,
    if_rx: `sum(vmanage_interface_rx_bits_per_second{${s}})`,
    if_tx: `sum(vmanage_interface_tx_bits_per_second{${s}})`
  };

  const out = {};
  await Promise.all(Object.entries(charts).map(async ([name, expr]) => {
    try {
      const result = await prom.queryRange(expr, start, end, step);
      out[name] = {
        available: result.length > 0,
        series: result.map((r) => ({
          metric: r.metric,
          values: (r.values || []).map(([ts, v]) => [Number(ts), Number(v)])
        }))
      };
    } catch (err) {
      out[name] = { available: false, error: err.message, series: [] };
    }
  }));

  function firstChart(names) {
    for (let i = 0; i < names.length; i++) {
      const n = names[i];
      if (out[n] && out[n].available && out[n].series && out[n].series.length) return out[n];
    }
    return { available: false, series: [] };
  }
  out.latency = firstChart(["latency_rec", "latency_vmanage", "latency_bfd", "latency_meraki"]);
  out.loss = firstChart(["loss_rec", "loss_vmanage", "loss_bfd", "loss_meraki"]);

  return {
    site_id: siteId,
    range: RANGE_WINDOWS[rangeKey] ? rangeKey : "1h",
    start,
    end,
    start_iso: isoFromUnix(start),
    end_iso: isoFromUnix(end),
    last_updated: new Date().toISOString(),
    step,
    charts: out
  };
}

module.exports = {
  THRESHOLDS,
  extractSiteId,
  validateSiteId,
  escapeLabel,
  snapshotQueries,
  getSiteSnapshot,
  getSiteSeries,
  buildWan,
  buildOspf,
  buildBgp,
  buildDevices,
  buildInterfaces,
  buildMeraki,
  buildSdwan,
  buildDefaultRoutes,
  collectIssues,
  overallFrom,
  RANGE_WINDOWS
};
