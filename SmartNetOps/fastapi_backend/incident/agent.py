from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Callable, Optional

from common.models import (
    Envelope,
    EvidenceItem,
    Hypothesis,
    IncidentAnalyzeIn,
    Solution,
)
from llm.parser import LLMParser


def classify(description: str, affected_server: Optional[str]) -> str:
    t = (description or "").lower()
    if any(w in t for w in ("bgp", "ospf", "route", "prefix")):
        return "routing"
    if any(w in t for w in ("wan", "circuit", "mpls", "sd-wan", "sdwan", "bfd")):
        return "wan"
    if any(w in t for w in ("firewall", "blocked", "denied", "acl")):
        return "firewall"
    if any(w in t for w in ("cpu", "memory", "disk", "service", "nginx", "apache", "timeout")):
        return "server"
    if affected_server:
        return "application_path"
    return "reachability"


def plan_tools(kind: str) -> list[str]:
    """Choose a small diagnostic path. Never 'run everything'."""
    table = {
        "application_path": [
            "server_health", "server_services", "server_connections", "server_routes",
            "network_interfaces", "network_routing", "network_bgp",
        ],
        "server": ["server_health", "server_services", "server_disk", "server_memory", "server_logs"],
        "wan": ["network_interfaces", "network_wan", "sdwan_bfd", "network_bgp"],
        "routing": ["network_routing", "network_bgp", "network_ospf"],
        "firewall": ["network_interfaces", "server_connections"],
        "reachability": ["server_health", "server_interfaces", "network_interfaces", "network_arp", "network_routing"],
    }
    return table.get(kind, table["reachability"])


def confidence_from(evidence: list[EvidenceItem], corroborated: bool) -> float:
    if not evidence:
        return 0.2
    highs = [e for e in evidence if e.severity in {"critical", "high"}]
    if corroborated and len(highs) >= 2:
        return 0.86
    if highs:
        return 0.62
    return 0.45


class IncidentAgent:
    """
    Stage 2 reasoning. Tools are FastAPI collectors passed in as callables.
    Parser output is treated as facts, never as root cause.
    """

    def __init__(self, network_tools: dict[str, Callable], server_tools: dict[str, Callable], llm: Optional[LLMParser] = None):
        self.network_tools = network_tools
        self.server_tools = server_tools
        self.llm = llm or LLMParser()

    async def run(self, body: IncidentAnalyzeIn, request_id: str) -> dict:
        started = datetime.now(timezone.utc).isoformat()
        kind = classify(body.description, body.affected_server)
        tools = plan_tools(kind)
        timeline = [{"step": 1, "action": "Identify site", "result": body.site_id}]
        if body.affected_server:
            timeline.append({"step": 2, "action": "Identify affected server", "result": body.affected_server})
        envelopes: list[Envelope] = []
        evidence: list[EvidenceItem] = []
        step = len(timeline) + 1

        for name in tools:
            fn = self.server_tools.get(name) or self.network_tools.get(name)
            if not fn:
                continue
            try:
                env: Envelope = await fn(body)
            except Exception as e:
                timeline.append({"step": step, "action": f"Tool {name}", "result": f"unavailable: {e}"})
                step += 1
                continue
            envelopes.append(env)
            evidence.extend(env.evidence)
            timeline.append({
                "step": step,
                "action": f"Tool {name}",
                "result": f"anomalies={len(env.anomalies)} parser={env.parser_status}",
            })
            step += 1
            # stop early if we have corroborated high-severity facts from two domains
            cats = {e.category for e in evidence if e.severity in {"critical", "high"}}
            sources = {e.source for e in evidence if e.severity in {"critical", "high"}}
            if len(high := [e for e in evidence if e.severity in {"critical", "high"}]) >= 2 and len(sources) >= 2:
                timeline.append({"step": step, "action": "Stop condition", "result": "corroborated high-severity evidence"})
                break

        hyps = self._hypotheses(kind, evidence, body)
        corroborated = any(h.supporting_evidence and not h.contradicting_evidence for h in hyps)
        conf = confidence_from(evidence, corroborated)

        facts = {
            "incident": body.model_dump(),
            "classification": kind,
            "evidence": [e.model_dump() for e in evidence],
            "hypotheses": [h.model_dump() for h in hyps],
            "anomalies": [a.model_dump() for e in envelopes for a in e.anomalies],
        }
        llm_out: dict[str, Any] = {}
        try:
            llm_out = self.llm.analyze_incident(facts)
        except Exception:
            llm_out = {}

        root = llm_out.get("root_cause") or self._fallback_root(kind, evidence, hyps, conf)
        status = "completed"
        if (root.get("status") if isinstance(root, dict) else None) == "unknown" or conf < 0.5:
            status = "requires_human_intervention"

        solutions = llm_out.get("possible_solutions") or [
            s.model_dump() for s in self._solutions(kind, evidence)
        ]
        for s in solutions:
            s["requires_human_approval"] = True

        explanation = llm_out.get("engineer_explanation") or self._explain(body, kind, evidence, root)

        return {
            "incident_id": body.incident_id,
            "summary": body.description,
            "impact": {
                "site": body.site_id,
                "service": body.affected_service,
                "severity": "high" if any(e.severity in {"critical", "high"} for e in evidence) else "medium",
            },
            "investigation": timeline,
            "timeline": timeline,
            "observations": [o.model_dump() for e in envelopes for o in e.observations],
            "anomalies": [a.model_dump() for e in envelopes for a in e.anomalies],
            "evidence": [e.model_dump() for e in evidence],
            "hypotheses": [h.model_dump() for h in hyps],
            "root_cause": root,
            "failure_reason": llm_out.get("failure_reason") or [
                e.observation for e in evidence if e.severity in {"critical", "high"}
            ][:6],
            "possible_solutions": solutions,
            "recommended_next_steps": llm_out.get("recommended_next_steps") or [
                "Have a human review evidence before any configuration change",
                "Validate the leading hypothesis with one additional collector if confidence is below 0.75",
            ],
            "confidence": llm_out.get("confidence") or conf,
            "requires_human_validation": True,
            "investigation_status": llm_out.get("investigation_status") or status,
            "engineer_explanation": explanation,
            "request_id": request_id,
            "started_at": started,
            "response": explanation,  # Hub UI reads .response as the analysis text
        }

    def _hypotheses(self, kind: str, evidence: list[EvidenceItem], body: IncidentAnalyzeIn) -> list[Hypothesis]:
        hyps: list[Hypothesis] = []
        by_cat = {}
        for e in evidence:
            by_cat.setdefault(e.category, []).append(e)

        def h(hid, text, ids, conf, status="possible"):
            hyps.append(Hypothesis(hypothesis_id=hid, hypothesis=text, supporting_evidence=ids, confidence=conf, status=status))

        if by_cat.get("bgp"):
            ids = [e.evidence_id for e in by_cat["bgp"]]
            h("H-BGP", "WAN/application path is broken because BGP is not Established", ids, 0.7, "probable")
        if by_cat.get("interface"):
            ids = [e.evidence_id for e in by_cat["interface"]]
            h("H-IF", "Path is down because an interface or line protocol is down", ids, 0.72, "probable")
        if by_cat.get("service"):
            ids = [e.evidence_id for e in by_cat["service"]]
            h("H-SVC", f"Application {body.affected_service or 'service'} failed on the server", ids, 0.68, "probable")
        if not hyps:
            h("H-UNK", "Insufficient evidence to name a component failure", [], 0.25, "unknown")
        return hyps

    def _fallback_root(self, kind, evidence, hyps, conf):
        if not evidence:
            return {"category": "unknown", "description": "Insufficient evidence to determine root cause", "confidence": 0.2, "status": "unknown"}
        top = max(hyps, key=lambda x: x.confidence)
        status = "probable" if conf >= 0.75 else "possible" if conf >= 0.5 else "unknown"
        return {"category": kind, "description": top.hypothesis, "confidence": conf, "status": status}

    def _solutions(self, kind, evidence) -> list[Solution]:
        return [
            Solution(priority=1, solution="Validate the failing component using the cited raw command output", reason="All conclusions are evidence-based and read-only", category=kind),
            Solution(priority=2, solution="If a change is required, open a change with human approval — this platform will not push config", reason="Remediation is human-in-the-loop by design", category="unknown"),
        ]

    def _explain(self, body, kind, evidence, root) -> str:
        lines = [
            f"Incident {body.incident_id} at site {body.site_id}: {body.description}",
            f"Classification: {kind}.",
            f"Root cause ({root.get('status')}): {root.get('description')}",
            "Evidence:",
        ]
        for e in evidence[:8]:
            lines.append(f"- {e.source}: {e.observation} (cmd {e.raw_command})")
        if not evidence:
            lines.append("- No collector evidence was available. Inventory/SSH/LLM may be unconfigured.")
        lines.append("No configuration change was executed.")
        return "\n".join(lines)
