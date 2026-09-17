"""
Smart NetOps — Network FastAPI (independently runnable).

Port 8001. Collects Cisco (Netmiko) and Meraki (HTTP) raw output, then
optionally parses it with the LLM layer. Does not reason about incidents
beyond exposing POST /api/v1/incident/analyze which uses the incident agent
and may call the Server API as a tool over HTTP.

Inventory is the existing site_id database. Credentials never leave this process.
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Optional

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from common.config import get_settings
from common.models import Envelope, IncidentAnalyzeIn, ScopeIn
from common.obs import RequestIdMiddleware, timed
from common.pipeline import build_envelope, http_error, parse_safe, rid
from common.security import redact_mapping
from incident.agent import IncidentAgent
from inventory.adapter import Inventory, get_inventory, normalize_site_id
from network.cisco import run_show
from network.commands import OPERATIONS
from network.meraki import MerakiClient

settings = get_settings()
inv: Inventory = get_inventory()
meraki = MerakiClient(settings)

app = FastAPI(
    title="Smart NetOps Network API",
    version="1.0.0",
    description="Read-only network collectors + LLM parse. site_id is the inventory primary key.",
)
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])
app.add_middleware(RequestIdMiddleware)


class SiteSearchIn(BaseModel):
    region: str
    country: str


class WorkflowIn(BaseModel):
    workflow: Optional[str] = None
    query: Optional[str] = None
    siteid: Optional[str] = None
    site: Optional[str] = None
    device: Optional[dict] = None
    ip: Optional[str] = None
    int_name: Optional[str] = None
    operation: Optional[str] = None
    source: Optional[dict] = None
    destination: Optional[str] = None
    options: Optional[dict] = None
    credentials: Optional[dict] = None


def _site_id(body: ScopeIn | WorkflowIn | dict) -> str:
    if isinstance(body, dict):
        return normalize_site_id(body.get("site_id") or body.get("siteid") or body.get("site"))
    return normalize_site_id(getattr(body, "site_id", None) or getattr(body, "siteid", None) or getattr(body, "site", None))


def _pick_device(site_id: str, hostname: Optional[str], ip: Optional[str]) -> dict:
    rows = inv.get_device_details(site_id, hostname or ip)
    if hostname or ip:
        if not rows:
            raise KeyError(f"device {hostname or ip} not in inventory for {site_id}")
        return rows[0]
    if not rows:
        raise KeyError(f"no network devices for site_id {site_id}")
    routers = [r for r in rows if (r.get("device_type") == "router") or "SD" in (r.get("hostname") or "").upper()]
    return (routers or rows)[0]


async def collect_op(request: Request, operation: str, body: ScopeIn) -> Envelope:
    site_id = _site_id(body)
    request_id = rid(request)
    with timed() as elapsed:
        try:
            site = inv.get_site_details(site_id)
            device = _pick_device(site_id, body.hostname or body.device_name, body.ip)
            target = {
                "hostname": device.get("hostname"),
                "ip": device.get("login_ip"),
                "device_type": device.get("device_type"),
                "vendor": device.get("vendor"),
                "platform": device.get("platform"),
            }
            vendor = (device.get("vendor") or device.get("platform") or "").lower()
            if "meraki" in vendor and meraki.enabled() and device.get("meraki_serial"):
                raw_json = meraki.device(device["meraki_serial"])
                raw = {
                    "command": f"GET /devices/{device['meraki_serial']}",
                    "raw_output": json.dumps(raw_json),
                    "device": device.get("hostname"),
                    "timestamp": datetime.now(timezone.utc).isoformat(),
                    "transport": "meraki",
                }
            else:
                password = inv.resolve_ssh_password(device)
                if not password:
                    raise RuntimeError("SSH password not resolved from vault/env for this device")
                command = OPERATIONS[operation]
                raw = await run_show(
                    device["login_ip"],
                    device.get("ssh_user") or "netops",
                    password,
                    device.get("platform") or "cisco_iosxe",
                    command,
                    device.get("hostname") or site_id,
                )
            parsed, pst = parse_safe("network", operation, raw["raw_output"], target)
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
        except Exception as e:
            http_error(e, request_id, operation, site_id)


def _op_route(operation: str):
    async def _inner(request: Request, body: ScopeIn):
        if operation not in OPERATIONS:
            raise HTTPException(400, f"unknown operation {operation}")
        return await collect_op(request, operation, body)

    return _inner


@app.get("/health")
@app.get("/health/live")
def health_live():
    return {"status": "ok", "service": "network", "port": 8001}


@app.get("/health/ready")
def health_ready():
    ok, detail = inv.ready()
    if not ok:
        raise HTTPException(503, {"status": "not_ready", "inventory": detail})
    return {"status": "ready", "inventory": detail, "llm": settings.llm_provider}


@app.post("/api/v1/network/site")
def network_site(body: ScopeIn, request: Request):
    site_id = _site_id(body)
    try:
        site = inv.get_site_details(site_id)
    except KeyError as e:
        raise HTTPException(404, str(e))
    return {"status": "success", "request_id": rid(request), "site_id": site_id, "data": redact_mapping(site)}


@app.post("/api/v1/network/devices")
def network_devices(body: ScopeIn, request: Request):
    site_id = _site_id(body)
    try:
        rows = inv.get_device_details(site_id, body.hostname or body.device_name)
    except Exception as e:
        raise HTTPException(404, str(e))
    return {
        "status": "success",
        "request_id": rid(request),
        "site_id": site_id,
        "devList": [inv.public_device(r) for r in rows],
        "data": {"devices": [inv.public_device(r) for r in rows]},
    }


for _name, _path in [
    ("device_facts", "/api/v1/network/device/facts"),
    ("device_health", "/api/v1/network/device/health"),
    ("interfaces", "/api/v1/network/interfaces"),
    ("interfaces_status", "/api/v1/network/interfaces/status"),
    ("interfaces_counters", "/api/v1/network/interfaces/counters"),
    ("arp", "/api/v1/network/arp"),
    ("mac", "/api/v1/network/mac"),
    ("vlans", "/api/v1/network/vlans"),
    ("trunks", "/api/v1/network/trunks"),
    ("stp", "/api/v1/network/stp"),
    ("routing", "/api/v1/network/routing"),
    ("vrf", "/api/v1/network/vrf"),
    ("ospf", "/api/v1/network/ospf"),
    ("ospf_neighbors", "/api/v1/network/ospf/neighbors"),
    ("ospf_interfaces", "/api/v1/network/ospf/interfaces"),
    ("bgp", "/api/v1/network/bgp"),
    ("bgp_neighbors", "/api/v1/network/bgp/neighbors"),
    ("bgp_routes", "/api/v1/network/bgp/routes"),
    ("cdp", "/api/v1/network/cdp"),
    ("lldp", "/api/v1/network/lldp"),
    ("vpn", "/api/v1/network/vpn"),
    ("ipsec", "/api/v1/network/ipsec"),
    ("dhcp", "/api/v1/network/dhcp"),
    ("wan", "/api/v1/network/wan"),
    ("wan_errors", "/api/v1/network/wan/errors"),
    ("sdwan_bfd", "/api/v1/network/sdwan/bfd"),
    ("sdwan_omp", "/api/v1/network/sdwan/omp"),
    ("sdwan_control", "/api/v1/network/sdwan/control"),
    ("logging", "/api/v1/network/logging"),
    ("environment", "/api/v1/network/environment"),
    ("config_running", "/api/v1/network/config/running"),
    ("config_startup", "/api/v1/network/config/startup"),
]:
    app.add_api_route(_path, _op_route(_name), methods=["POST"], response_model=Envelope)


@app.post("/api/v1/network/wan/utilization")
async def wan_util(request: Request, body: ScopeIn):
    """Meraki org uplink if configured; otherwise interface counters on the WAN router."""
    if meraki.enabled() and body.extra.get("org_id"):
        data = meraki.org_uplink_status(body.extra["org_id"])
        return {"status": "success", "request_id": rid(request), "operation": "wan_utilization", "data": data,
                "raw_data": {"command": "GET /appliance/uplink/statuses", "raw_output": json.dumps(data)}}
    return await collect_op(request, "wan_errors", body)


@app.post("/api/v1/network/sdwan")
async def sdwan(request: Request, body: ScopeIn):
    return await collect_op(request, "sdwan_control", body)


@app.post("/api/v1/network/topology")
def topology(body: ScopeIn, request: Request):
    """Inventory + optional CDP/LLDP crawl is a follow-on; this returns inventory graph seed."""
    site_id = _site_id(body)
    rows = inv.get_device_details(site_id)
    elements = []
    for r in rows:
        elements.append({
            "group": "nodes",
            "data": {
                "id": r.get("hostname"),
                "label": r.get("hostname"),
                "ip": r.get("login_ip"),
                "platform": r.get("platform"),
                "type": r.get("device_type"),
                "source": "inventory",
                "discovered": True,
                "depth": 0,
                "vendorColor": "#22D3EE",
                "vendorFill": "rgba(34,211,238,.10)",
            },
        })
    return {
        "status": "success",
        "request_id": rid(request),
        "site_id": site_id,
        "stats": {"nodes": len(elements), "edges": 0, "meraki": 0, "undiscovered": 0, "discovered": len(elements)},
        "warnings": ["Edges require live CDP/LLDP collection via /api/v1/network/cdp and /lldp"],
        "elements": elements,
    }


# ----- Hub UI compatibility (do not change the HTML) -----

@app.post("/siteIdGet")
def legacy_sites(body: SiteSearchIn):
    try:
        sites = inv.sites_for_country(body.region, body.country)
    except Exception as e:
        raise HTTPException(502, str(e))
    return {"sites": sites}


@app.post("/aio")
async def legacy_aio(request: Request, body: WorkflowIn):
    wf = (body.workflow or "").strip()
    site_id = normalize_site_id(body.siteid or body.site)
    if wf == "DEVICE_DISCOVERY" or body.query == "FETCH_DEVICES":
        rows = inv.get_device_details(site_id)
        return {"response": {"opString": f"DEVICE_DISCOVERY {site_id}", "devList": [inv.public_device(r) for r in rows]}}
    if wf == "Health check of Device":
        host = (body.device or {}).get("hostname")
        scope = ScopeIn(site_id=site_id, hostname=host, ip=(body.device or {}).get("ip"))
        env = await collect_op(request, "device_health", scope)
        return {"response": env.model_dump()}
    if wf in OPERATIONS or (body.operation or "").upper() == "TRACEROUTE":
        op = "interfaces" if wf == "Check Network Status" else "device_health"
        if wf == "PATH_ANALYSIS" or body.operation:
            op = "routing"
        env = await collect_op(request, op if op in OPERATIONS else "interfaces", ScopeIn(site_id=site_id, ip=body.ip, hostname=(body.device or {}).get("hostname") if body.device else None))
        return {"response": env.model_dump()}
    return {"response": {"opString": f"workflow {wf} mapped to inventory-only until a collector is selected", "devList": [inv.public_device(r) for r in inv.get_device_details(site_id)]}}


@app.post("/api/v1/incident/analyze")
async def incident_analyze(request: Request, body: IncidentAnalyzeIn):
    """Stage-2 agent. Network tools local; server tools via HTTP to server_api."""
    import httpx

    request_id = rid(request)
    body.site_id = normalize_site_id(body.site_id or body.site)
    if body.number and not body.incident_id:
        body.incident_id = body.number

    async def net_tool(op: str):
        async def _call(inc: IncidentAnalyzeIn) -> Envelope:
            return await collect_op(request, op, ScopeIn(site_id=inc.site_id, hostname=inc.affected_server, incident_id=inc.incident_id))
        return _call

    async def srv_tool(path: str):
        async def _call(inc: IncidentAnalyzeIn) -> Envelope:
            async with httpx.AsyncClient(timeout=60) as client:
                r = await client.post(
                    settings.server_api_base_url.rstrip("/") + path,
                    json={"site_id": inc.site_id, "hostname": inc.affected_server, "incident_id": inc.incident_id},
                )
                r.raise_for_status()
                return Envelope.model_validate(r.json())
        return _call

    agent = IncidentAgent(
        network_tools={
            "network_interfaces": await net_tool("interfaces"),
            "network_routing": await net_tool("routing"),
            "network_bgp": await net_tool("bgp"),
            "network_ospf": await net_tool("ospf_neighbors"),
            "network_arp": await net_tool("arp"),
            "network_wan": await net_tool("wan"),
            "sdwan_bfd": await net_tool("sdwan_bfd"),
        },
        server_tools={
            "server_health": await srv_tool("/api/v1/server/health"),
            "server_services": await srv_tool("/api/v1/server/services"),
            "server_connections": await srv_tool("/api/v1/server/connections"),
            "server_routes": await srv_tool("/api/v1/server/routes"),
            "server_disk": await srv_tool("/api/v1/server/disk"),
            "server_memory": await srv_tool("/api/v1/server/memory"),
            "server_logs": await srv_tool("/api/v1/server/logs"),
            "server_interfaces": await srv_tool("/api/v1/server/interfaces"),
        },
    )
    return await agent.run(body, request_id)


@app.post("/askLlm")
async def chat(request: Request, body: dict):
    site_id = normalize_site_id(body.get("site"))
    try:
        devices = [inv.public_device(r) for r in inv.get_device_details(site_id)]
    except Exception:
        devices = []
    reply = (
        f"Network ChatOps for {site_id}: {len(devices)} inventory devices. "
        "I will not push configuration. Use /api/v1/incident/analyze for troubleshooting."
    )
    return {"response": reply}


@app.post("/updateData")
def usage(body: dict):
    return {"ok": True, "stored": False, "note": "usage sink — wire to your existing updateData store"}
