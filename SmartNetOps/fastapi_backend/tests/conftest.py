from __future__ import annotations

from typing import Optional


class FakeInventory:
    def __init__(self):
        self.site = {
            "site_id": "IND-MUM-DC-018",
            "region": "APAC",
            "country": "India",
            "U_SITE_ID": "IND-MUM-DC-018",
        }
        self.devices = [
            {
                "site_id": "IND-MUM-DC-018",
                "hostname": "MUM-SDWAN-01",
                "login_ip": "10.18.0.1",
                "device_type": "router",
                "platform": "cisco_iosxe",
                "vendor": "cisco",
                "status": "up",
                "ssh_user": "netops",
            }
        ]
        self.servers = [
            {
                "site_id": "IND-MUM-DC-018",
                "hostname": "mum-lnx-app01",
                "login_ip": "10.30.2.11",
                "os": "RHEL 9",
                "role": "Application",
                "env": "Prod",
                "status": "up",
                "ssh_user": "ops",
            }
        ]

    def ready(self):
        return True, "ok"

    def get_site_details(self, site_id: str) -> dict:
        if site_id != "IND-MUM-DC-018":
            raise KeyError(site_id)
        return dict(self.site)

    def get_device_details(self, site_id: str, device_name: Optional[str] = None):
        rows = [dict(d) for d in self.devices]
        if device_name:
            rows = [r for r in rows if r["hostname"] == device_name or r["login_ip"] == device_name]
        return rows

    def get_server_details(self, site_id: str, hostname: Optional[str] = None):
        rows = [dict(s) for s in self.servers]
        if hostname:
            rows = [r for r in rows if r["hostname"] == hostname]
        return rows

    def public_device(self, row):
        return {"U_HOSTNAME": row["hostname"], "U_LOGIN_IP": row["login_ip"], "hostname": row["hostname"], "ip": row["login_ip"]}

    def public_server(self, row):
        return {"U_HOSTNAME": row["hostname"], "U_LOGIN_IP": row["login_ip"], "U_OS": row["os"], "hostname": row["hostname"], "ip": row["login_ip"], "os": row["os"], "status": row["status"]}

    def resolve_ssh_password(self, row):
        return "unused-in-tests"

    def sites_for_country(self, region, country):
        return [{"U_SITE_ID": "IND-MUM-DC-018", "U_CITY": "Mumbai"}]
