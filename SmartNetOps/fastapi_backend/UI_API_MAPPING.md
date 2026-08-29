# UI → API mapping

Source of truth: SmartNetOps HTML (Monitoring `logicmonitor.html` and Dashboard `dashboard.html` excluded).

| Page | UI field | How the UI gets it today | Backend | JSON | Status |
|---|---|---|---|---|---|
| Landing | Region / country / site | POST proxy1 `{region,country}` → `U_SITE_ID`, address parts | `POST /siteIdGet` | `sites[].U_SITE_ID` | Implemented (existing DB) |
| Landing | Site master | POST `/api/site-info` `{region,country,site}` | `POST /api/v1/network/site` | site row | Implemented |
| Site-Info Update | 15 master fields | POST proxy2 `{workflow:Site Update, siteid, query}` | existing CMDB via inventory UPDATE is **not** enabled (read-only policy). Use your current `aio` Site Update path until change-control exists. | query pipe-separated | **Gap: write path kept on legacy CMDB** |
| NetAutomation | DevList hostname / login IP | `DEVICE_DISCOVERY` / `U_HOSTNAME` `U_LOGIN_IP` | `POST /aio` or `/api/v1/network/devices` | `response.devList` | Implemented |
| NetAutomation | Audit / CMDB / Handover | workflow name as query | `/aio` maps to inventory + collectors | `response` | Partial (live show commands, not NCM archive) |
| NetAutomation | Health check | selected device | `/api/v1/network/device/health` | envelope | Implemented |
| NetAutomation | Interface status All/WAN/LAN | `{ip, int_name}` | `/api/v1/network/interfaces/status` | `raw_data` + parsed `data` | Implemented (scope filter is parser-side) |
| Network Diagram | Seed host/IP, platform, depth, Meraki | DEVICE_DISCOVERY + topology POST | `/api/v1/network/devices` + `/topology` + `/cdp` `/lldp` | Cytoscape `elements` | Inventory graph implemented; live CDP edges **need device session** |
| Path Analysis | Source host/IP, dest, operation, hop RTT/loss | PATH_ANALYSIS SSH on source | `/api/v1/network/routing` + traceroute is **not** a `show` on many platforms | hops | **Gap: traceroute/MTR not in show-only catalog** — keep Path Analysis on existing runner or add an approved `traceroute` allowlist later |
| Circuit Diversity | Router A/B IPs, dest, hop compare | DEVICE_DISCOVERY + `/api/analyze` | `/api/v1/network/devices` (SD/router) | diversity | **Gap: live dual traceroute still belongs on the existing analyzer** |
| Firewall | Rule table (priority, name, src, dst, port, proto, action, status) | in-page sample array | not in production DB in this repo | — | **Gap: rules live in UI memory today** |
| Firewall | FSR 14-char, AI issue text, policy detail | simulated | `/api/v1/incident/analyze` + inventory | `response` | Partial |
| ChatOps / Network with Us | message, region, country, site | POST `/proxy` → askLlm | `POST /askLlm` | `response` | Implemented (no secrets) |
| Request/Incident AI | type, number, site | POST snow placeholder | `POST /api/v1/incident/analyze` | `response` + full agent body | Implemented |
| Server Automation | hostname, IP, OS, role, env, status | `SERVER_DISCOVERY` `U_*` | `POST /aio` on **8002** or `/api/v1/server/details` | `srvList` | Implemented |
| Server Automation | workflows (health, disk, patch, logs, …) | `{workflow, siteid, option, servers[]}` | `/aio` maps to `/api/v1/server/*` | envelope | Implemented (read-only; no patch install) |
| Cloud Automation | provider, accounts, instances | CLOUD_DISCOVERY | — | — | **Out of scope** (neither Network nor Server) |
| Admin | activity logs | localStorage | — | — | Client-only |

## Values displayed vs source

| Value | Inventory DB | Live device/server | LLM |
|---|---|---|---|
| Hostname, login IP, type, vendor, OS, role, env, region, country | yes | no | no |
| Interface/BGP/OSPF/ARP/MAC/VLAN/CPU/memory/disk/services | no | yes (raw) | structured fields only if present in raw |
| Credentials | vault/env in FastAPI only | never in UI/LLM | never |

## Explicit gaps

1. Site-Info **writes** remain on the current CMDB `aio` workflow (this release is read-only).  
2. Path Analysis traceroute/MTR/pcap and Circuit Diversity live traceroute are not `show` commands; do not pretend they are.  
3. Firewall policy table is not in the inventory schema found in this repo.  
4. Cloud Automation has no third FastAPI in this task.  
5. Monitoring and Dashboard were not mapped, as requested.
