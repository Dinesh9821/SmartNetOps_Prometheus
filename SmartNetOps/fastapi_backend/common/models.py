from __future__ import annotations

from typing import Any, Literal, Optional

from pydantic import BaseModel, Field, field_validator

ParserStatus = Literal["success", "failed", "skipped", "partial"]
OpStatus = Literal["success", "partial", "error"]
Severity = Literal["critical", "high", "medium", "low", "informational"]
CauseStatus = Literal["confirmed", "probable", "possible", "unknown"]
EvidenceKind = Literal["observed", "not_observed", "unknown", "derived"]


class Target(BaseModel):
    hostname: Optional[str] = None
    ip: Optional[str] = None
    device_type: Optional[str] = None
    type: Optional[str] = None
    vendor: Optional[str] = None
    site_id: Optional[str] = None


class Observation(BaseModel):
    field: Optional[str] = None
    value: Any = None
    status: Literal["observed", "not_observed", "unknown", "derived"] = "observed"
    evidence: Optional[str] = None


class Anomaly(BaseModel):
    category: str
    severity: Severity = "medium"
    field: Optional[str] = None
    observation: str
    evidence: str
    evidence_kind: EvidenceKind = "observed"


class EvidenceItem(BaseModel):
    evidence_id: str
    source: str
    category: str
    observation: str
    severity: Severity = "informational"
    observed_at: str
    raw_command: Optional[str] = None
    raw_data_reference: Optional[str] = None


class Hypothesis(BaseModel):
    hypothesis_id: str
    hypothesis: str
    supporting_evidence: list[str] = Field(default_factory=list)
    contradicting_evidence: list[str] = Field(default_factory=list)
    confidence: float = 0.0
    status: CauseStatus = "possible"


class Solution(BaseModel):
    priority: int
    solution: str
    reason: str
    category: str = "unknown"
    requires_human_approval: bool = True


class RawCapture(BaseModel):
    command: str
    raw_output: str
    device: Optional[str] = None
    timestamp: str
    transport: Optional[str] = None


class Metadata(BaseModel):
    timestamp: str
    execution_time: float = 0.0
    parser: str = "llm"
    parser_version: str = "1.0"
    parser_status: ParserStatus = "skipped"
    collector_status: str = "success"


class Envelope(BaseModel):
    status: OpStatus = "success"
    request_id: str
    site_id: Optional[str] = None
    incident_id: Optional[str] = None
    target: Target = Field(default_factory=Target)
    operation: str
    data: dict[str, Any] = Field(default_factory=dict)
    observations: list[Observation] = Field(default_factory=list)
    anomalies: list[Anomaly] = Field(default_factory=list)
    evidence: list[EvidenceItem] = Field(default_factory=list)
    raw_data: dict[str, Any] = Field(default_factory=dict)
    parsed_data: Optional[dict[str, Any]] = None
    parser_status: ParserStatus = "skipped"
    metadata: Metadata

    @field_validator("data", mode="before")
    @classmethod
    def _data(cls, v):
        return v or {}


class ParsedLLM(BaseModel):
    operation: str
    status: Literal["success", "partial", "error"] = "success"
    target: Target = Field(default_factory=Target)
    data: dict[str, Any] = Field(default_factory=dict)
    observations: list[Observation] = Field(default_factory=list)
    anomalies: list[Anomaly] = Field(default_factory=list)
    evidence: list[dict[str, Any]] = Field(default_factory=list)
    raw_data_reference: Optional[str] = None


class IncidentAnalyzeIn(BaseModel):
    incident_id: str
    site_id: str
    description: str
    affected_service: Optional[str] = None
    affected_server: Optional[str] = None
    type: Optional[str] = None
    number: Optional[str] = None
    region: Optional[str] = None
    country: Optional[str] = None
    site: Optional[str] = None
    siteInfo: Any = None


class ScopeIn(BaseModel):
    site_id: Optional[str] = None
    siteid: Optional[str] = None
    site: Optional[str] = None
    hostname: Optional[str] = None
    device_name: Optional[str] = None
    ip: Optional[str] = None
    incident_id: Optional[str] = None
    region: Optional[str] = None
    country: Optional[str] = None
    extra: dict[str, Any] = Field(default_factory=dict)
