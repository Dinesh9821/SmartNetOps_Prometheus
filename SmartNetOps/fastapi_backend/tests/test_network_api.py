import pytest
from fastapi.testclient import TestClient

import network_api
from tests.conftest import FakeInventory


@pytest.fixture
def client(monkeypatch):
    fake = FakeInventory()
    monkeypatch.setattr(network_api, "inv", fake)

    async def fake_show(*args, **kwargs):
        return {
            "command": "show ip bgp summary",
            "raw_output": "Neighbor 10.10.10.2 State: Active",
            "device": "MUM-SDWAN-01",
            "timestamp": "2026-08-29T12:00:00Z",
            "raw_data_reference": "mem://test",
        }

    monkeypatch.setattr("network_api.run_show", fake_show)
    return TestClient(network_api.app)


def test_health(client):
    r = client.get("/health/live")
    assert r.status_code == 200
    assert r.json()["service"] == "network"


def test_devices_from_inventory(client):
    r = client.post("/api/v1/network/devices", json={"site_id": "IND-MUM-DC-018"})
    assert r.status_code == 200
    assert r.json()["devList"][0]["U_HOSTNAME"] == "MUM-SDWAN-01"
    assert "password" not in str(r.json()).lower() or "***" in str(r.json())


def test_unknown_site(client):
    r = client.post("/api/v1/network/site", json={"site_id": "NOPE"})
    assert r.status_code == 404


def test_bgp_collect_preserves_raw(client):
    r = client.post("/api/v1/network/bgp", json={"site_id": "IND-MUM-DC-018", "hostname": "MUM-SDWAN-01"})
    assert r.status_code == 200
    body = r.json()
    assert "Neighbor 10.10.10.2" in body["raw_data"]["raw_output"]
    assert body["operation"] == "bgp"


def test_legacy_discovery(client):
    r = client.post("/aio", json={"workflow": "DEVICE_DISCOVERY", "query": "FETCH_DEVICES", "siteid": "IND-MUM-DC-018"})
    assert r.json()["response"]["devList"][0]["U_HOSTNAME"] == "MUM-SDWAN-01"
