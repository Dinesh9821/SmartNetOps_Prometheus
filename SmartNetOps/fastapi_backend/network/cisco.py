from __future__ import annotations

import asyncio
import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from common.config import get_settings
from common.security import assert_cisco_show, redact_mapping
from network.commands import PLATFORM_MAP

_semaphore: Optional[asyncio.Semaphore] = None


def _sem() -> asyncio.Semaphore:
    global _semaphore
    if _semaphore is None:
        _semaphore = asyncio.Semaphore(get_settings().max_collector_concurrency)
    return _semaphore


def persist_raw(raw: dict, settings=None) -> str:
    s = settings or get_settings()
    Path(s.raw_capture_dir).mkdir(parents=True, exist_ok=True)
    ref = hashlib.sha256((raw.get("command", "") + raw.get("timestamp", "")).encode()).hexdigest()[:16]
    path = Path(s.raw_capture_dir) / f"{raw.get('device','unknown')}_{ref}.json"
    safe = redact_mapping(raw)
    path.write_text(json.dumps(safe, indent=2), encoding="utf-8")
    return str(path)


def netmiko_connect_and_run(host: str, username: str, password: str, platform: str, command: str, timeout: int) -> str:
    from netmiko import ConnectHandler  # imported lazily so unit tests can mock

    device_type = PLATFORM_MAP.get((platform or "cisco_iosxe").lower(), "cisco_ios")
    conn = ConnectHandler(
        device_type=device_type,
        host=host,
        username=username,
        password=password,
        timeout=timeout,
        conn_timeout=timeout,
        auth_timeout=timeout,
    )
    try:
        return conn.send_command(command, read_timeout=timeout)
    finally:
        conn.disconnect()


async def run_show(host: str, username: str, password: str, platform: str, command: str, device_name: str) -> dict:
    cmd = assert_cisco_show(command)
    settings = get_settings()
    ts = datetime.now(timezone.utc).isoformat()
    async with _sem():
        output = await asyncio.to_thread(
            netmiko_connect_and_run, host, username, password, platform, cmd, settings.netmiko_timeout
        )
    raw = {
        "command": cmd,
        "raw_output": output,
        "device": device_name,
        "timestamp": ts,
        "transport": "netmiko",
    }
    raw["raw_data_reference"] = persist_raw(raw)
    return raw
