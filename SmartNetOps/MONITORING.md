# SmartNetOps Monitoring

Site-level network monitoring inside the existing SmartNetOps Hub. The landing page still supplies **Region → Country → Site ID**. The Monitoring page reads `localStorage.selectedSite` (first `|`-separated token) and asks the proxy backend for Prometheus data. The browser never sends PromQL and never talks to Prometheus directly.

Prometheus: `http://cussya5x.carcgl.com:9090` (override with `PROMETHEUS_URL`).  
Proxy: existing `SmartNetOps/proxy-server` on port 8080.

## New page

- UI: `SmartNetOps/monitoring.html`
- Open from **Operations Home → Monitoring** (requires a selected site)
- Command palette: **Monitoring**

## API endpoints

All PromQL is constructed in `proxy-server/monitoringService.js`.

| Method | Path | Purpose |
| ------ | ---- | ------- |
| GET | `/api/monitoring/:siteId` | Consolidated snapshot for one site |
| GET | `/api/monitoring?site_id=` | Same, query-string form |
| GET | `/api/monitoring/:siteId/series?range=15m\|1h\|6h\|24h` | Time-series for charts |

`site_id` is validated (`^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$`). Invalid values return **400** with `Invalid or unknown Site ID`. Prometheus down/timeout returns **503** with `Monitoring data temporarily unavailable`. A live Prometheus with no series for that site returns **200** and `overall_status: UNKNOWN` so the UI can show **No telemetry data available for this site**.

Example snapshot shape:

```json
{
  "site_id": "IND-PUN-001",
  "overall_status": "HEALTHY",
  "last_updated": "...",
  "devices": {},
  "wan": {},
  "ospf": {},
  "bgp": {},
  "hosts": {},
  "interfaces": {},
  "meraki": {},
  "sdwan": {},
  "issues": []
}
```

## Thresholds (from Grafana)

From `Network_Telemetry/wan-dashboard.json` Peak Utilisation + “links over 80%” panel:

| Utilization | Grafana color | SmartNetOps issue |
| ----------- | ------------- | ----------------- |
| ≥ 60% | yellow | INFO |
| ≥ 80% | orange (and count panel) | WARNING |
| ≥ 95% | red | CRITICAL |

WAN `up == 0` is CRITICAL. Meraki `0.5` (alerting) is WARNING / DEGRADED.

## Grafana mapping

| Monitoring section | Prometheus metric(s) | PromQL (site filtered) | Grafana reference |
| ------------------ | -------------------- | ---------------------- | ----------------- |
| Overall health | `site_health_percent`, device/WAN/routing issues | `site_health_percent{site_id="…"}` plus derived issues | complete-observability.json “Site health” |
| Devices KPI | `site_devices_total:all`, `site_devices_up:all`, `device_info` | `{site_id="…"}` | complete-observability + inventory-dashboard |
| WAN KPI / table / util | `wan_link_up`, `wan_link_rx_bits_per_second`, `wan_link_tx_bits_per_second`, `wan_link_utilization_percent`, `wan_link_capacity_bits_per_second`, `vmanage_wan_link_info` | unified recording rules, site_id | wan-dashboard.json, complete-observability WAN panels |
| WAN latency/loss | `vmanage_wan_link_latency_ms`, `vmanage_wan_link_loss_percent`; Meraki uplinks joined `and on(serial) meraki_device_up{site_id}` | site-scoped | vManage WAN exporter + Meraki uplink quality |
| OSPF | `vmanage_ospf_neighbor_state_info`, `vmanage_ospf_neighbor_up`, `vmanage_ospf_neighbor_uptime_seconds`, totals | `{site_id="…"}` | sdwan-dashboard.json routing family / exporter |
| BGP | `vmanage_bgp_neighbor_state_info`, `vmanage_bgp_neighbor_up`, `vmanage_bgp_prefixes_received` | `{site_id="…"}` | sdwan-dashboard.json BGP state table |
| Devices table | `device_info`, `meraki_device_up`, `meraki_device_status_info`, `meraki_device_memory_used_percent`, `meraki_device_cpu_load5`, `vmanage_device_reachable`, `vmanage_device_uptime_seconds` | `{site_id="…"}` | inventory + site-carrier-* device panels |
| Interfaces | `vmanage_interface_oper_up` + rx/tx/errors/drops/speed | `{site_id="…"}` | sdwan-dashboard interface traffic/errors |
| Meraki | `meraki_site_devices_total/online`, `meraki_site_devices_by_role`, `meraki_switch_client_count`, `meraki_switch_ports_with_errors`, `meraki_ap_channel_utilization_percent`, uplink status | `{site_id="…"}` | site-carrier-* Site Observability |
| SD-WAN | `vmanage_bfd_session_*`, `vmanage_omp_*`, `vmanage_control_connections_up`, `overlay_sessions_*` | `{site_id="…"}` | sdwan-dashboard.json BFD/OMP/control |

## Missing metrics (not invented)

- **Host / ICMP status** — no ping/host exporter in Network Telemetry. Host Status explains this; device reachability is under Device Status.
- **BGP uptime** — exporter has state and prefixes, not peer uptime.
- **`meraki_uplink_util_percent`** — referenced in generated Meraki Grafana JSON but **not emitted** by `meraki-exporter`. Utilization uses unified `wan_link_utilization_percent`.
- Meraki uplink gauges lack `site_id`; they are scoped with `and on(serial) meraki_device_up{site_id="…"}`.

## Run tests

```bash
cd SmartNetOps/proxy-server
node monitoring.test.js
```

Restart the existing proxy (`node server.js`) so `/api/monitoring` is served.
