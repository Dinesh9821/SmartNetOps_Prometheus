# Server API

Independent FastAPI app: `server_api.py` on **port 8002**. It does **not** import Cisco/Netmiko collectors from the Network API.

```bash
cd SmartNetOps/fastapi_backend
uvicorn server_api:app --host 0.0.0.0 --port 8002
```

## Role

Linux (SSH + allowlisted read-only commands). Windows is reserved (`501`).

`get_server_details(site_id, hostname=None)` reads the existing inventory. Live facts (CPU, memory, disk, services) are collected **from the server itself**. Inventory credentials are used only inside this process.

## Commands (allowlist)

hostnamectl, uname, os-release, uptime, ip, ss, df, free, ps, systemctl status, journalctl (read), lsblk, resolv.conf. Pipes, `rm`, reboot, and `systemctl stop` are rejected.

## Endpoints

| Method | Path | Command |
|---|---|---|
| GET | `/health` `/health/live` `/health/ready` | process / DB |
| POST | `/api/v1/server/details` | inventory only |
| POST | `/api/v1/server/health` | `uptime` |
| POST | `/api/v1/server/cpu` | `/proc/loadavg` |
| POST | `/api/v1/server/memory` | `free -m` |
| POST | `/api/v1/server/disk` | `lsblk` |
| POST | `/api/v1/server/filesystems` | `df -h` |
| POST | `/api/v1/server/processes` | `ps aux` |
| POST | `/api/v1/server/services` | `systemctl status` |
| POST | `/api/v1/server/interfaces` | `ip -o addr` |
| POST | `/api/v1/server/routes` | `ip route` |
| POST | `/api/v1/server/arp` | `ip neigh` |
| POST | `/api/v1/server/connections` | `ss -tulpn` |
| POST | `/api/v1/server/dns` | `resolv.conf` |
| POST | `/api/v1/server/uptime` `/kernel` `/os` | uptime / uname / os-release |
| POST | `/api/v1/server/logs` | `journalctl -n 100` |
| POST | `/api/v1/server/config` | hostnamectl |
| POST | `/aio` | Hub Server Automation Flow (`SERVER_DISCOVERY` + workflows) |

SSH uses `asyncio.to_thread` so the event loop is not blocked. Concurrency is capped (`MAX_COLLECTOR_CONCURRENCY`).

No configuration changes. Service start/stop is not exposed.
