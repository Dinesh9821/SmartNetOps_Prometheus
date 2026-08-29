from __future__ import annotations

import asyncio
import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from common.config import get_settings
from common.security import assert_linux_readonly, redact_mapping

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
    path = Path(s.raw_capture_dir) / f"srv_{raw.get('device','unknown')}_{ref}.json"
    path.write_text(json.dumps(redact_mapping(raw), indent=2), encoding="utf-8")
    return str(path)


def ssh_run(host: str, username: str, password: str, command: str, timeout: int) -> str:
    import paramiko

    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    try:
        client.connect(
            hostname=host, username=username, password=password,
            timeout=timeout, look_for_keys=False, allow_agent=False,
        )
        _, stdout, stderr = client.exec_command(command, timeout=timeout)
        out = stdout.read().decode("utf-8", "replace")
        err = stderr.read().decode("utf-8", "replace")
        return (out or err).strip()
    finally:
        client.close()


async def run_linux(host: str, username: str, password: str, command: str, hostname: str) -> dict:
    cmd = assert_linux_readonly(command)
    settings = get_settings()
    ts = datetime.now(timezone.utc).isoformat()
    async with _sem():
        output = await asyncio.to_thread(ssh_run, host, username, password, cmd, settings.ssh_timeout)
    raw = {
        "command": cmd,
        "raw_output": output,
        "device": hostname,
        "timestamp": ts,
        "transport": "ssh",
    }
    raw["raw_data_reference"] = persist_raw(raw)
    return raw
