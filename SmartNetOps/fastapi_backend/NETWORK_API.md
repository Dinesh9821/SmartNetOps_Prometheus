# Network API

Independent FastAPI app: `network_api.py` on **port 8001**.

```bash
cd SmartNetOps/fastapi_backend
pip install -r requirements.txt
cp .env.example .env   # set DATABASE_URL to the EXISTING inventory DB
uvicorn network_api:app --host 0.0.0.0 --port 8001
```

## Role

FastAPI is the **tool layer**: inventory lookup, credential retrieval (vault/env), Cisco Netmiko / Meraki HTTP, timeouts, retries, logging. It does **not** decide root cause.

Flow: `site_id` → `get_device_details` → SSH/`show …` or Meraki GET → **raw output retained** → LLM parser (optional) → envelope JSON.

## Inventory

`get_site_details(site_id)` and `get_device_details(site_id, device_name=None)` read the production database. This service does **not** create or seed a replacement CMDB. Default SQL expects the `U_*` columns the Hub already uses (`U_SITE_ID`, `U_HOSTNAME`, `U_LOGIN_IP`, …). Override with `INVENTORY_SITE_SQL` / `INVENTORY_DEVICE_SQL`.

Credentials: `resolve_ssh_password` via `SSH_PASSWORD_<HOSTNAME>` or `SSH_PASSWORD_DEFAULT`. Never returned in JSON, never sent to the LLM.

## Endpoints

| Method | Path | Source |
|---|---|---|
| GET | `/health` `/health/live` `/health/ready` | liveness / inventory |
| POST | `/api/v1/network/site` | existing DB |
| POST | `/api/v1/network/devices` | existing DB |
| POST | `/api/v1/network/device/facts` | `show version` |
| POST | `/api/v1/network/device/health` | `show version` |
| POST | `/api/v1/network/interfaces` `/status` `/counters` | `show ip interface brief` / `show interfaces` |
| POST | `/api/v1/network/arp` `/mac` `/vlans` `/trunks` `/stp` | matching show commands |
| POST | `/api/v1/network/routing` `/vrf` | `show ip route` / `show vrf` |
| POST | `/api/v1/network/ospf` `/ospf/neighbors` `/ospf/interfaces` | OSPF show |
| POST | `/api/v1/network/bgp` `/bgp/neighbors` `/bgp/routes` | BGP show |
| POST | `/api/v1/network/cdp` `/lldp` `/topology` | neighbors / inventory graph |
| POST | `/api/v1/network/vpn` `/ipsec` `/dhcp` | crypto / DHCP |
| POST | `/api/v1/network/wan` `/wan/utilization` `/wan/errors` | WAN / Meraki uplinks |
| POST | `/api/v1/network/sdwan` `/sdwan/bfd` `/omp` `/control` | Viptela show |
| POST | `/api/v1/network/logging` `/environment` | logging / env |
| POST | `/api/v1/network/config/running` `/startup` | **read-only** show |
| POST | `/api/v1/incident/analyze` | agent (see INCIDENT_AGENT_ARCHITECTURE.md) |
| POST | `/siteIdGet` `/aio` `/askLlm` `/updateData` | Hub UI compatibility |

Request body for collectors:

```json
{ "site_id": "IND-MUM-DC-018", "hostname": "MUM-SDWAN-01", "incident_id": "INC0012345" }
```

Only `show …` commands are allowed. Configure / write / reload are rejected.

## Envelope

Every collector returns the common envelope (`status`, `request_id`, `site_id`, `target`, `operation`, `data`, `observations`, `anomalies`, `evidence`, `raw_data`, `parser_status`, `metadata`). If the LLM fails, `raw_data` is still present and `status` is `partial`.
