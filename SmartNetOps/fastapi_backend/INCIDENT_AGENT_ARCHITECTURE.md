# Incident Agent Architecture

```
Incident
  → Inventory (site_id)
  → Tool selection (few collectors, not all)
  → FastAPI Network / Server
  → Raw CLI/API output (retained, secrets redacted)
  → LLM Parser (facts + obvious anomalies only)
  → Structured facts
  → Evidence
  → Hypothesis
  → Validation (additional tools)
  → Root cause (confirmed | probable | possible | unknown)
  → Solutions (recommend only)
  → Human approval
  → Remediation engine (NOT in this release)
  → Post-change validation (future)
```

## Separation of duties

| Layer | Allowed | Forbidden |
|---|---|---|
| FastAPI | connect, collect, timeout, log | root cause |
| LLM parser | schema JSON from raw text | inventing values, RCA |
| Incident agent | choose tools, correlate, hypothesise, explain | executing config |

Prompts are versioned (`PROMPT_VERSION`, files in `prompts/`).

## Endpoint

`POST /api/v1/incident/analyze` on the **Network** API (port 8001).

Compatible with Hub `request-incident-analysis.html` fields (`type`, `number`, `site`) and the enterprise body:

```json
{
  "incident_id": "INC0012345",
  "site_id": "IND-MUM-DC-018",
  "description": "Users cannot access ERP application",
  "affected_service": "ERP",
  "affected_server": "mum-lnx-app01"
}
```

Server tools are invoked over HTTP (`SERVER_API_BASE_URL`) so the two FastAPI processes stay separate.

## Investigation strategy (example)

ERP unreachable:

1. Site inventory  
2. Server health / service / listening ports / routes  
3. Gateway / router interfaces, ARP, routing, BGP/WAN only if the server path is healthy  
4. Stop when two independent high-severity sources agree, or collectors are exhausted  

## Output

Matches the enterprise contract: `summary`, `impact`, `investigation`/`timeline`, `observations`, `anomalies`, `evidence` (with `raw_command`), `hypotheses`, `root_cause.status`, `failure_reason`, `possible_solutions` (all `requires_human_approval: true`), `recommended_next_steps`, `confidence`, `investigation_status`, `engineer_explanation`. The Hub UI can display `response` as the engineer paragraph.

If evidence is insufficient, `root_cause.status` is `unknown` and `investigation_status` is `requires_human_intervention`.
