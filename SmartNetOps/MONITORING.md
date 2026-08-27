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

Latency and loss/drops are filled in this order when present:

1. Unified recording rules `wan_link_latency_milliseconds` / `wan_link_loss_percent`
2. Exporter `vmanage_wan_link_latency_ms` / `vmanage_wan_link_loss_percent`
3. BFD session averages by hostname/colour
4. Meraki `meraki_uplink_latency_milliseconds` / `meraki_uplink_loss_percent` joined on `serial` to `meraki_device_up{site_id}`
5. Packet **drops** from `vmanage_wan_link_rx_drops` + `vmanage_wan_link_tx_drops`

Meraki uplink series do not carry `site_id`; they are attached to the same WAN row as utilization by matching `network`/`uplink` or `serial`/`uplink`.

## Grafana mapping

| Monitoring section | Prometheus metric(s) | PromQL (site filtered) | Grafana reference |
| ------------------ | -------------------- | ---------------------- | ----------------- |
| Overall health | `site_health_percent`, device/WAN/routing issues | `site_health_percent{site_id="…"}` plus derived issues | complete-observability.json “Site health” |
| Devices KPI | `site_devices_total:all`, `site_devices_up:all`, `device_info` | `{site_id="…"}` | complete-observability + inventory-dashboard |
| WAN KPI / table / util | `wan_link_up`, `wan_link_admin_up` / `vmanage_wan_link_admin_up`, rx/tx/util/capacity, `vmanage_wan_link_info`, jitter | `{site_id="…"}` | wan-dashboard.json; vmanage-wan-rules.yml admin state |
| Default routes | `vmanage_default_route_present` | `{site_id="…"}` | vManage exporter (VPN default-route coverage) |
| OSPF | `vmanage_ospf_neighbor_state_info`, `vmanage_ospf_neighbor_up`, `vmanage_ospf_neighbor_uptime_seconds`, totals | `{site_id="…"}` | sdwan-dashboard.json routing family / exporter |
| BGP | `vmanage_bgp_neighbor_state_info`, `vmanage_bgp_neighbor_up`, `vmanage_bgp_prefixes_received` | `{site_id="…"}` | sdwan-dashboard.json BGP state table |
| Devices table | `device_info`, `meraki_device_up`, `meraki_device_status_info`, `meraki_device_memory_used_percent`, `meraki_device_cpu_load5`, `vmanage_device_reachable`, `vmanage_device_uptime_seconds` | `{site_id="…"}` | inventory + site-carrier-* device panels |
| Interfaces | `vmanage_interface_oper_up` + rx/tx/errors/drops/speed | `{site_id="…"}` | sdwan-dashboard interface traffic/errors |
| Meraki | site device counts, switch ports total/connected/errors/warnings, PoE, client count, AP util / Wi‑Fi / non‑Wi‑Fi | `{site_id="…"}` | site-carrier-* Site Observability |
| SD-WAN | BFD session up/latency/loss/jitter/**uptime**, OMP state + routes received/installed/sent, control connections | `{site_id="…"}` | sdwan-dashboard.json BFD/OMP/control |

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
