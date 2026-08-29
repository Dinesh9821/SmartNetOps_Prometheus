"""
Smart NetOps — Server FastAPI (independently runnable).

Port 8002. Linux SSH only (Windows reserved). Collects raw command output,
then optionally parses with the LLM. Never accepts arbitrary commands.
Read-only. Credentials never returned.
"""

from __future__ import annotations

from typing import Optional

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from common.config import get_settings
from common.models import Envelope, ScopeIn
from common.obs import RequestIdMiddleware, timed
from common.pipeline import build_envelope, http_error, parse_safe, rid
from inventory.adapter import Inventory, get_inventory, normalize_site_id
from server.commands import OPERATIONS
from server.ssh import run_linux

settings = get_settings()
inv: Inventory = get_inventory()

app = FastAPI(
    title="Smart NetOps Server API",
    version="1.0.0",
    description="Read-only Linux collectors + LLM parse. Inventory keyed by site_id.",
)
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])
app.add_middleware(RequestIdMiddleware)


class WorkflowIn(BaseModel):
    workflow: Optional[str] = None
    query: Optional[str] = None
    siteid: Optional[str] = None
    servers: Optional[list] = None
    option: Optional[str] = None


def _site_id(body: ScopeIn) -> str:
    return normalize_site_id(body.site_id or body.siteid or body.site)


def _pick_server(site_id: str, hostname: Optional[str]) -> dict:
    rows = inv.get_server_details(site_id, hostname)
    linux = [
        r for r in rows
        if "win" not in (r.get("os") or "").lower() and "esxi" not in (r.get("os") or "").lower()
    ]
    pool = linux or rows
    if not pool:
        raise KeyError(f"no servers for site_id {site_id}")
    return pool[0]


async def collect_op(request: Request, operation: str, body: ScopeIn) -> Envelope:
    site_id = _site_id(body)
    request_id = rid(request)
    with timed() as elapsed:
        try:
            inv.get_site_details(site_id)
            srv = _pick_server(site_id, body.hostname)
            osname = (srv.get("os") or "").lower()
            if "windows" in osname:
                raise HTTPException(501, "Windows collectors are not implemented yet")
            password = inv.resolve_ssh_password(srv)
            if not password:
                raise RuntimeError("SSH password not resolved from vault/env for this server")
            command = OPERATIONS[operation]
            raw = await run_linux(
                srv["login_ip"],
                srv.get("ssh_user") or "ops",
                password,
                command,
                srv.get("hostname") or site_id,
            )
            target = {
                "hostname": srv.get("hostname"),
                "ip": srv.get("login_ip"),
                "device_type": "linux",
                "os": srv.get("os"),
            }
            parsed, pst = parse_safe("server", operation, raw["raw_output"], target)
            return build_envelope(
                request_id=request_id,
                site_id=site_id,
                incident_id=body.incident_id,
                operation=operation,
                target=target,
                raw=raw,
                parsed=parsed,
                parser_status=pst,
                elapsed=elapsed(),
            )
        except HTTPException:
            raise
        except Exception as e:
            http_error(e, request_id, operation, site_id)


def _route(operation: str):
    async def _inner(request: Request, body: ScopeIn):
        return await collect_op(request, operation, body)
    return _inner


@app.get("/health")
@app.get("/health/live")
def live():
    return {"status": "ok", "service": "server", "port": 8002}


@app.get("/health/ready")
def ready():
    ok, detail = inv.ready()
    if not ok:
        raise HTTPException(503, {"status": "not_ready", "inventory": detail})
    return {"status": "ready", "inventory": detail, "llm": settings.llm_provider}


@app.post("/api/v1/server/details")
def server_details(body: ScopeIn, request: Request):
    site_id = _site_id(body)
    try:
        rows = inv.get_server_details(site_id, body.hostname)
    except Exception as e:
        raise HTTPException(404, str(e))
    return {
        "status": "success",
        "request_id": rid(request),
        "site_id": site_id,
        "srvList": [inv.public_server(r) for r in rows],
        "data": {"servers": [inv.public_server(r) for r in rows]},
    }


for _op, _path in [
    ("health", "/api/v1/server/health"),
    ("cpu", "/api/v1/server/cpu"),
    ("memory", "/api/v1/server/memory"),
    ("disk", "/api/v1/server/disk"),
    ("filesystems", "/api/v1/server/filesystems"),
    ("processes", "/api/v1/server/processes"),
    ("services", "/api/v1/server/services"),
    ("interfaces", "/api/v1/server/interfaces"),
    ("routes", "/api/v1/server/routes"),
    ("arp", "/api/v1/server/arp"),
    ("connections", "/api/v1/server/connections"),
    ("dns", "/api/v1/server/dns"),
    ("uptime", "/api/v1/server/uptime"),
    ("kernel", "/api/v1/server/kernel"),
    ("os", "/api/v1/server/os"),
    ("logs", "/api/v1/server/logs"),
    ("config", "/api/v1/server/config"),
]:
    app.add_api_route(_path, _route(_op), methods=["POST"], response_model=Envelope)


@app.post("/aio")
async def legacy_aio(request: Request, body: WorkflowIn):
    """Server Automation Flow contract: SERVER_DISCOVERY + named workflows."""
    site_id = normalize_site_id(body.siteid)
    wf = (body.workflow or "").strip()
    if wf == "SERVER_DISCOVERY" or body.query == "FETCH_SERVERS":
        rows = inv.get_server_details(site_id)
        return {"response": {"srvList": [inv.public_server(r) for r in rows], "devList": [inv.public_server(r) for r in rows]}}
    host = None
    if body.servers:
        host = (body.servers[0] or {}).get("hostname") if isinstance(body.servers[0], dict) else str(body.servers[0])
    mapping = {
        "Health Check of Server": "health",
        "Hardware Performance": "cpu",
        "Patch Compliance Report": "os",
        "Disk Capacity Forecast": "filesystems",
        "Log Bundle & Root Cause": "logs",
        "Check Audit Compliance": "os",
        "Check CMDB Compliance": "details",
        "Backup Verification": "disk",
        "Certificate & Service Expiry": "services",
        "Privileged Access Review": "os",
    }
    op = mapping.get(wf, "health")
    if operation := (op if op in OPERATIONS else "health"):
        env = await collect_op(request, "health" if operation == "details" else operation, ScopeIn(site_id=site_id, hostname=host))
        return {"response": env.model_dump()}
    return {"response": {"opString": wf}}
