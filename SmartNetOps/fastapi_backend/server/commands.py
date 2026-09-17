"""Linux read-only command catalog. Windows is reserved."""

OPERATIONS = {
    "details": "hostnamectl",
    "health": "uptime",
    "cpu": "cat /proc/loadavg",
    "memory": "free -m",
    "disk": "lsblk",
    "filesystems": "df -h",
    "processes": "ps aux",
    "services": "systemctl status --no-pager",
    "interfaces": "ip -o addr",
    "routes": "ip route",
    "arp": "ip neigh",
    "connections": "ss -tulpn",
    "dns": "cat /etc/resolv.conf",
    "uptime": "uptime",
    "kernel": "uname -a",
    "os": "cat /etc/os-release",
    "logs": "journalctl -n 100 --no-pager",
    "config": "hostnamectl",
}
