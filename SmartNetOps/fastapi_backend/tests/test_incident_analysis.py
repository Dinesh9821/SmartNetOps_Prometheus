import pytest

from common.models import Envelope, EvidenceItem, IncidentAnalyzeIn, Metadata, Target
from incident.agent import IncidentAgent, classify, plan_tools, confidence_from


def test_classify_wan():
    assert classify("WAN circuit down at the site", None) == "wan"


def test_plan_does_not_run_everything():
    tools = plan_tools("wan")
    assert "server_logs" not in tools
    assert "sdwan_bfd" in tools
    assert len(tools) < 12


def test_low_confidence_without_evidence():
    assert confidence_from([], False) < 0.5


@pytest.mark.asyncio
async def test_agent_stop_and_no_remediation():
    async def iface(inc):
        return Envelope(
            status="success",
            request_id="R",
            site_id=inc.site_id,
            operation="interfaces",
            target=Target(hostname="RTR01", ip="10.18.0.1"),
            data={},
            anomalies=[],
            evidence=[
                EvidenceItem(
                    evidence_id="EV001",
                    source="RTR01",
                    category="interface",
                    observation="GigabitEthernet0/0 is down",
                    severity="critical",
                    observed_at="2026-08-29T12:00:00Z",
                    raw_command="show ip interface brief",
                )
            ],
            raw_data={"command": "show ip interface brief", "raw_output": "Gi0/0 down"},
            metadata=Metadata(timestamp="2026-08-29T12:00:00Z", parser_status="skipped"),
        )

    class DummyLLM:
        def analyze_incident(self, facts):
            raise RuntimeError("offline")

    agent = IncidentAgent(
        network_tools={"network_interfaces": iface, "network_wan": iface, "sdwan_bfd": iface, "network_bgp": iface},
        server_tools={},
        llm=DummyLLM(),
    )
    out = await agent.run(
        IncidentAnalyzeIn(
            incident_id="INC001",
            site_id="IND-MUM-DC-018",
            description="Users cannot access ERP",
            affected_service="ERP",
        ),
        "REQ1",
    )
    assert out["requires_human_validation"] is True
    assert all(s.get("requires_human_approval") for s in out["possible_solutions"])
    assert out["root_cause"]["status"] in {"probable", "possible", "unknown", "confirmed"}
    assert out["evidence"][0]["raw_command"]
