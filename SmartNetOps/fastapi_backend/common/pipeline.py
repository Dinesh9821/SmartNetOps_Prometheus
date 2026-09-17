from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Optional

from fastapi import HTTPException, Request

from common.models import Anomaly, Envelope, EvidenceItem, Metadata, ParsedLLM, Target
from common.obs import new_request_id, timed
from llm.parser import LLMParser

_parser: Optional[LLMParser] = None


def parser() -> LLMParser:
    global _parser
    if _parser is None:
        _parser = LLMParser()
    return _parser


def rid(request: Optional[Request]) -> str:
    if request is not None and hasattr(request.state, "request_id"):
        return request.state.request_id
    return new_request_id()


def parse_safe(kind: str, operation: str, raw_output: str, target: dict) -> tuple[Optional[ParsedLLM], str]:
    try:
        p = parser()
        if kind == "server":
            parsed = p.parse_server_output(operation, raw_output, target)
        else:
            parsed = p.parse_network_output(operation, raw_output, target)
        return parsed, "success"
    except Exception:
        return None, "failed" if getattr(parser().provider, "name", "") != "none" else "skipped"


def rule_anomalies(operation: str, raw_output: str) -> list[Anomaly]:
    """Deterministic flags from raw text only. Not root cause."""
    text = raw_output or ""
    low = text.lower()
    found: list[Anomaly] = []

    def add(cat, sev, field, obs, needle):
        if needle.lower() in low:
            idx = low.find(needle.lower())
            quote = text[max(0, idx - 20) : idx + 80].strip()
            found.append(Anomaly(category=cat, severity=sev, field=field, observation=obs, evidence=quote))

    if "administratively down" in low:
        add("interface", "critical", None, "Interface is administratively down", "administratively down")
    if "line protocol is down" in low:
        add("interface", "high", None, "Line protocol is down", "line protocol is down")
    if "idle" in low and "bgp" in operation:
        add("bgp", "high", None, "BGP neighbor is not Established", "Idle")
    if " active" in low and "bgp" in operation:
        add("bgp", "high", None, "BGP neighbor is not Established", "Active")
    if "init/" in low or "init\n" in low:
        add("ospf", "high", None, "OSPF neighbor not FULL", "INIT")
    if "failed" in low and "service" in operation or (operation == "services" and "failed" in low):
        add("service", "high", None, "Service reported failed", "failed")
    return found


def build_envelope(
    *,
    request_id: str,
    site_id: Optional[str],
    operation: str,
    target: dict,
    raw: dict,
    parsed: Optional[ParsedLLM],
    parser_status: str,
    elapsed: float,
    incident_id: Optional[str] = None,
) -> Envelope:
    data = parsed.data if parsed else {}
    anomalies = list(parsed.anomalies) if parsed else []
    anomalies.extend(rule_anomalies(operation, raw.get("raw_output") or ""))
    observations = list(parsed.observations) if parsed else []
    now = datetime.now(timezone.utc).isoformat()
    evidence = []
    for a in anomalies:
        evidence.append(
            EvidenceItem(
                evidence_id="EV-" + uuid.uuid4().hex[:8].upper(),
                source=target.get("hostname") or raw.get("device") or "unknown",
                category=a.category,
                observation=a.observation,
                severity=a.severity,
                observed_at=now,
                raw_command=raw.get("command"),
                raw_data_reference=raw.get("raw_data_reference"),
            )
        )
    status = "success"
    if parser_status == "failed":
        status = "partial"
    return Envelope(
        status=status,
        request_id=request_id,
        site_id=site_id,
        incident_id=incident_id,
        target=Target(
            hostname=target.get("hostname"),
            ip=target.get("ip") or target.get("login_ip"),
            device_type=target.get("device_type") or target.get("os"),
            type=target.get("device_type"),
            vendor=target.get("vendor"),
            site_id=site_id,
        ),
        operation=operation,
        data=data,
        observations=observations,
        anomalies=anomalies,
        evidence=evidence,
        raw_data={"command": raw.get("command"), "raw_output": raw.get("raw_output"),
                  "device": raw.get("device"), "timestamp": raw.get("timestamp"),
                  "raw_data_reference": raw.get("raw_data_reference")},
        parsed_data=parsed.model_dump() if parsed else None,
        parser_status=parser_status,  # type: ignore
        metadata=Metadata(
            timestamp=now,
            execution_time=elapsed,
            parser="llm",
            parser_version=parser().prompt_version,
            parser_status=parser_status,  # type: ignore
        ),
    )


def http_error(exc: Exception, request_id: str, operation: str, site_id: Optional[str] = None):
    if isinstance(exc, PermissionError):
        raise HTTPException(403, {"status": "error", "request_id": request_id, "operation": operation, "detail": str(exc)})
    if isinstance(exc, KeyError):
        raise HTTPException(404, {"status": "error", "request_id": request_id, "operation": operation, "detail": str(exc)})
    raise HTTPException(500, {"status": "error", "request_id": request_id, "operation": operation, "detail": str(exc)})
