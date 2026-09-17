from __future__ import annotations

from typing import Optional

import httpx

from common.config import get_settings


class MerakiClient:
    def __init__(self, settings=None):
        self.settings = settings or get_settings()

    def enabled(self) -> bool:
        return bool(self.settings.meraki_api_key)

    def _headers(self) -> dict:
        return {"X-Cisco-Meraki-API-Key": self.settings.meraki_api_key, "Accept": "application/json"}

    def get(self, path: str, params: Optional[dict] = None) -> dict:
        if not self.enabled():
            raise RuntimeError("MERAKI_API_KEY is not configured")
        url = self.settings.meraki_base_url.rstrip("/") + path
        with httpx.Client(timeout=30) as client:
            r = client.get(url, headers=self._headers(), params=params)
            r.raise_for_status()
            return r.json()

    def device(self, serial: str) -> dict:
        return self.get(f"/devices/{serial}")

    def lldp_cdp(self, serial: str) -> dict:
        return self.get(f"/devices/{serial}/lldpCdp")

    def uplink(self, serial: str) -> dict:
        return self.get(f"/devices/{serial}/appliance/uplinks/settings")

    def org_uplink_status(self, org_id: str) -> dict:
        return self.get(f"/organizations/{org_id}/appliance/uplink/statuses")
