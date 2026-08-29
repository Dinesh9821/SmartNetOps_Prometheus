# Smart NetOps FastAPI backends

Two independently runnable services plus shared libraries (inventory adapter, LLM parser, security). They do **not** replace the existing inventory database.

| App | File | Port |
|---|---|---|
| Network | `network_api.py` | 8001 |
| Server | `server_api.py` | 8002 |

See `NETWORK_API.md`, `SERVER_API.md`, `INCIDENT_AGENT_ARCHITECTURE.md`, `UI_API_MAPPING.md`.

```bash
pip install -r requirements.txt
uvicorn network_api:app --port 8001
uvicorn server_api:app --port 8002
pytest
```
