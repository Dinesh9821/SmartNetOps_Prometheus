from __future__ import annotations

import re
from typing import Iterable

SECRET_KEYS = {
    "password", "passwd", "secret", "api_key", "apikey", "token",
    "privatekey", "private_key", "passphrase", "enablepassword", "enable_password",
}

DANGEROUS_CISCO = re.compile(
    r"^\s*(configure|conf t|write|reload|clear|copy |delete |erase |"
    r"debug |undebug |request |set |install |upgrade |format )",
    re.I,
)

DANGEROUS_LINUX = re.compile(
    r"(rm\s+-rf|mkfs|dd\s+if=|shutdown|reboot|halt|userdel|passwd\s|"
    r"iptables\s+-F|systemctl\s+(stop|disable|mask)|chmod\s+777|"
    r"curl\s+.+\|\s*sh|wget\s+.+\|\s*sh)",
    re.I,
)

ALLOWED_LINUX_PREFIXES = (
    "hostname", "hostnamectl", "uname", "cat /etc/os-release", "uptime",
    "ip ", "ss ", "df", "free", "ps ", "systemctl status", "journalctl",
    "cat /proc/cpuinfo", "cat /proc/meminfo", "cat /proc/loadavg",
    "lsblk", "ip route", "ip -s link", "cat /etc/resolv.conf",
    "getent", "who", "last -n", "timedatectl",
)


def redact_mapping(obj):
    if isinstance(obj, dict):
        out = {}
        for k, v in obj.items():
            if str(k).lower().replace("-", "_") in SECRET_KEYS:
                out[k] = "***redacted***"
            else:
                out[k] = redact_mapping(v)
        return out
    if isinstance(obj, list):
        return [redact_mapping(x) for x in obj]
    return obj


def assert_cisco_show(command: str) -> str:
    cmd = (command or "").strip()
    if not cmd:
        raise ValueError("empty command")
    if DANGEROUS_CISCO.search(cmd) or not cmd.lower().startswith("show"):
        raise PermissionError(f"Rejected non-show / dangerous Cisco command: {cmd!r}")
    return cmd


def assert_linux_readonly(command: str, allowlist: Iterable[str] = ALLOWED_LINUX_PREFIXES) -> str:
    cmd = (command or "").strip()
    if not cmd:
        raise ValueError("empty command")
    if DANGEROUS_LINUX.search(cmd) or "|" in cmd or ";" in cmd or "&&" in cmd or "`" in cmd:
        raise PermissionError(f"Rejected dangerous Linux command: {cmd!r}")
    if not any(cmd == p or cmd.startswith(p) for p in allowlist):
        raise PermissionError(f"Linux command not on the read-only allowlist: {cmd!r}")
    return cmd
