import pytest
from fastapi.testclient import TestClient

import server_api
from tests.conftest import FakeInventory


@pytest.fixture
def client(monkeypatch):
    monkeypatch.setattr(server_api, "inv", FakeInventory())

    async def fake_ssh(*args, **kwargs):
        return {
            "command": "uptime",
            "raw_output": " 12:00:00 up 10 days,  3 users,  load average: 0.10, 0.20, 0.30",
            "device": "mum-lnx-app01",
            "timestamp": "2026-08-29T12:00:00Z",
            "raw_data_reference": "mem://test",
        }

    monkeypatch.setattr("server_api.run_linux", fake_ssh)
    return TestClient(server_api.app)


def test_health(client):
    assert client.get("/health").json()["service"] == "server"


def test_inventory_details(client):
    r = client.post("/api/v1/server/details", json={"site_id": "IND-MUM-DC-018"})
    assert r.status_code == 200
    assert r.json()["srvList"][0]["U_OS"] == "RHEL 9"


def test_health_raw(client):
    r = client.post("/api/v1/server/health", json={"site_id": "IND-MUM-DC-018", "hostname": "mum-lnx-app01"})
    assert r.status_code == 200
    assert "load average" in r.json()["raw_data"]["raw_output"]


def test_legacy_discovery(client):
    r = client.post("/aio", json={"workflow": "SERVER_DISCOVERY", "query": "FETCH_SERVERS", "siteid": "IND-MUM-DC-018"})
    assert r.json()["response"]["srvList"][0]["U_HOSTNAME"] == "mum-lnx-app01"
