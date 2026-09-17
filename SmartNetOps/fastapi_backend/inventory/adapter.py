"""
Read-only adapter over the EXISTING inventory database.

site_id (U_SITE_ID) is the primary key. This module does not create tables,
seed data, or replace CMDB. Column names default to the U_* fields the
Hub UI already consumes from siteIdGet / DEVICE_DISCOVERY / SERVER_DISCOVERY.
"""

from __future__ import annotations

import os
import re
from functools import lru_cache
from typing import Any, Optional

from sqlalchemy import create_engine, text
from sqlalchemy.engine import Engine
from sqlalchemy.exc import SQLAlchemyError

from common.config import get_settings

SITE_SQL = """
SELECT
  COALESCE(U_SITE_ID, site_id) AS site_id,
  COALESCE(U_REGION, region) AS region,
  COALESCE(U_COUNTRY, country) AS country,
  U_STREET_ADDRESS AS street_address,
  U_CITY AS city,
  U_STATE AS state,
  U_PINCODE AS zipcode,
  U_SITE_PRIORITY AS site_priority,
  U_BUSINESS_UNIT AS business_unit,
  U_BUILDING_FLOOR AS building_floor,
  U_BUILDING_TYPE AS building_type,
  U_PRIMARY_CONTACT_NAME AS primary_contact_name,
  U_SECONDARY_CONTACT_NAME AS secondary_contact_name,
  U_PRIMARY_CONTACT AS primary_contact,
  U_SECONDARY_CONTACT AS secondary_contact,
  U_PRIMARY_CONTACT_EMAIL AS primary_contact_email,
  U_SECONDARY_CONTACT_EMAIL AS secondary_contact_email
FROM sites
WHERE COALESCE(U_SITE_ID, site_id) = :site_id
"""

DEVICE_SQL = """
SELECT
  COALESCE(U_SITE_ID, site_id) AS site_id,
  COALESCE(U_HOSTNAME, hostname, device_name) AS hostname,
  COALESCE(U_LOGIN_IP, device_ip, ip) AS login_ip,
  COALESCE(U_TYPE, device_type, type) AS device_type,
  COALESCE(U_PLATFORM, platform) AS platform,
  COALESCE(U_VENDOR, vendor) AS vendor,
  COALESCE(U_STATUS, status) AS status,
  ssh_user,
  vault_ref,
  meraki_serial,
  meraki_org,
  meraki_network
FROM network_devices
WHERE COALESCE(U_SITE_ID, site_id) = :site_id
"""

SERVER_SQL = """
SELECT
  COALESCE(U_SITE_ID, site_id) AS site_id,
  COALESCE(U_HOSTNAME, hostname) AS hostname,
  COALESCE(U_LOGIN_IP, server_ip, ip) AS login_ip,
  COALESCE(U_OS, os, platform) AS os,
  COALESCE(U_ROLE, role, class) AS role,
  COALESCE(U_ENV, environment, env) AS env,
  COALESCE(U_STATUS, status) AS status,
  ssh_user,
  vault_ref
FROM servers
WHERE COALESCE(U_SITE_ID, site_id) = :site_id
"""


def normalize_site_id(raw: Optional[str]) -> str:
    if not raw:
        return ""
    return str(raw).split("|")[0].strip()


def _row(m: Any) -> dict:
    if m is None:
        return {}
    if hasattr(m, "_mapping"):
        return {k: m._mapping[k] for k in m._mapping.keys()}
    return dict(m)


class Inventory:
    def __init__(self, engine: Optional[Engine] = None, settings=None):
        self.settings = settings or get_settings()
        self.engine = engine
        if engine is None and self.settings.database_url:
            self.engine = create_engine(self.settings.database_url, pool_pre_ping=True, future=True)

    def ready(self) -> tuple[bool, str]:
        if self.engine is None:
            return False, "DATABASE_URL is not configured"
        try:
            with self.engine.connect() as c:
                c.execute(text("SELECT 1"))
            return True, "ok"
        except SQLAlchemyError as e:
            return False, str(e)

    def _q(self, sql: str, **params):
        if self.engine is None:
            raise RuntimeError("Inventory database is not configured (DATABASE_URL).")
        with self.engine.connect() as c:
            return [_row(r) for r in c.execute(text(sql), params)]

    def get_site_details(self, site_id: str) -> dict:
        site_id = normalize_site_id(site_id)
        sql = self.settings.inventory_site_sql or SITE_SQL
        rows = self._q(sql, site_id=site_id)
        if not rows:
            raise KeyError(f"site_id not found: {site_id}")
        return rows[0]

    def get_device_details(self, site_id: str, device_name: Optional[str] = None) -> list[dict]:
        site_id = normalize_site_id(site_id)
        sql = self.settings.inventory_device_sql or DEVICE_SQL
        rows = self._q(sql, site_id=site_id)
        if device_name:
            key = device_name.lower()
            rows = [r for r in rows if (r.get("hostname") or "").lower() == key
                    or (r.get("login_ip") or "") == device_name]
        return rows

    def get_server_details(self, site_id: str, hostname: Optional[str] = None) -> list[dict]:
        site_id = normalize_site_id(site_id)
        sql = self.settings.inventory_server_sql or SERVER_SQL
        rows = self._q(sql, site_id=site_id)
        if hostname:
            key = hostname.lower()
            rows = [r for r in rows if (r.get("hostname") or "").lower() == key
                    or (r.get("login_ip") or "") == hostname]
        return rows

    def public_device(self, row: dict) -> dict:
        """UI-safe device record. No credentials."""
        return {
            "U_HOSTNAME": row.get("hostname"),
            "U_LOGIN_IP": row.get("login_ip"),
            "U_TYPE": row.get("device_type"),
            "U_PLATFORM": row.get("platform"),
            "U_VENDOR": row.get("vendor"),
            "U_STATUS": row.get("status"),
            "hostname": row.get("hostname"),
            "ip": row.get("login_ip"),
            "type": row.get("device_type") or "Network device",
            "platform": row.get("platform"),
        }

    def public_server(self, row: dict) -> dict:
        return {
            "U_HOSTNAME": row.get("hostname"),
            "U_LOGIN_IP": row.get("login_ip"),
            "U_OS": row.get("os"),
            "U_ROLE": row.get("role"),
            "U_ENV": row.get("env"),
            "U_STATUS": row.get("status"),
            "hostname": row.get("hostname"),
            "ip": row.get("login_ip"),
            "os": row.get("os"),
            "role": row.get("role"),
            "env": row.get("env"),
            "status": (row.get("status") or "up"),
        }

    def resolve_ssh_password(self, row: dict) -> Optional[str]:
        """Credentials stay in FastAPI. Never returned to UI/LLM."""
        backend = (self.settings.vault_backend or "env").lower()
        host = (row.get("hostname") or "").upper().replace("-", "_")
        if backend == "env":
            return (
                os.environ.get(f"SSH_PASSWORD_{host}")
                or os.environ.get("SSH_PASSWORD_DEFAULT")
                or None
            )
        # Plug HashiCorp/CyberArk here using row['vault_ref']
        return None

    def sites_for_country(self, region: str, country: str) -> list[dict]:
        sql = """
        SELECT
          COALESCE(U_SITE_ID, site_id) AS U_SITE_ID,
          U_STREET_ADDRESS, U_CITY, U_STATE, U_COUNTRY, U_PINCODE
        FROM sites
        WHERE lower(COALESCE(U_REGION, region)) = lower(:region)
          AND lower(COALESCE(U_COUNTRY, country)) = lower(:country)
        """
        if self.settings.inventory_site_sql:
            # caller should set a dedicated search query if schema differs
            pass
        return self._q(sql, region=region, country=country)


@lru_cache
def get_inventory() -> Inventory:
    return Inventory()
