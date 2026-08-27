#!/usr/bin/env python3
"""
Probe a live vManage and report which state entities exist and what fields
they carry. Read-only. Run this BEFORE and AFTER deploying the exporter fix.

Why this exists: vManage entity names and field spellings differ between
20.x releases and between vEdge and IOS-XE SD-WAN fleets. The exporter probes
candidates at runtime and records the winner in vmanage_endpoint_available,
but when a panel is blank you want the answer in ten seconds, from a shell,
without correlating metrics. This prints exactly that.

Usage:
    export VMANAGE_HOST=vmanage.example.com
    export VMANAGE_USER=telemetry-ro
    export VMANAGE_PASS='...'
    python3 probe-vmanage-entities.py                 # summary
    python3 probe-vmanage-entities.py --sample 2      # include sample rows
    python3 probe-vmanage-entities.py --signal interface

Exit code is 1 if no interface entity answered, so it can gate a deployment.
"""
import argparse
import http.cookiejar
import json
import os
import ssl
import sys
import urllib.error
import urllib.parse
import urllib.request

HOST = os.environ.get("VMANAGE_HOST", "").strip()
PORT = int(os.environ.get("VMANAGE_PORT", "443"))
USER = os.environ.get("VMANAGE_USER", "").strip()
PASS = os.environ.get("VMANAGE_PASS", "")
VERIFY = os.environ.get("VMANAGE_VERIFY_TLS", "false").lower() == "true"
TIMEOUT = int(os.environ.get("REQUEST_TIMEOUT_SECONDS", "60"))
COUNT = int(os.environ.get("PROBE_COUNT", "200"))

# Same candidate list the exporter uses, kept in sync deliberately.
SIGNALS = {
    "interface": ["/dataservice/data/device/state/InterfaceCEdge",
                  "/dataservice/data/device/state/InterfaceVEdge",
                  "/dataservice/data/device/state/Interface"],
    "tloc": ["/dataservice/data/device/state/ControlLocalProperty",
             "/dataservice/data/device/state/ControlLocalProperties",
             "/dataservice/data/device/state/ControlWanInterface",
             "/dataservice/data/device/state/ControlWanInterfaceCEdge",
             "/dataservice/data/device/state/ControlWanInterfaceVEdge"],
    "omp": ["/dataservice/data/device/state/OMPPeer",
            "/dataservice/data/device/state/OMPPeers"],
    "bfd": ["/dataservice/data/device/state/BFDSessions",
            "/dataservice/data/device/state/BFDSession"],
    "bgp": ["/dataservice/data/device/state/CEdgeBGPNeighbor",
            "/dataservice/data/device/state/VEdgeBGPNeighbor",
            "/dataservice/data/device/state/BGPNeighbor",
            "/dataservice/data/device/state/BGPNeighbors",
            "/dataservice/data/device/state/BgpNeighbor"],
    "ospf": ["/dataservice/data/device/state/CEdgeOspfNeighbor",
             "/dataservice/data/device/state/OspfNeighbor",
             "/dataservice/data/device/state/OSPFNeighbor",
             "/dataservice/data/device/state/OspfNeighbors"],
    "eigrp": ["/dataservice/data/device/state/CEdgeEigrpNeighbor",
              "/dataservice/data/device/state/EigrpNeighbor",
              "/dataservice/data/device/state/EIGRPNeighbor",
              "/dataservice/data/device/state/CEdgeEIGRPNeighbor",
              "/dataservice/data/device/state/EigrpNeighbors"],
    "route": ["/dataservice/data/device/state/CEdgeIPRoute",
              "/dataservice/data/device/state/IPRoute",
              "/dataservice/data/device/state/IpRoute",
              "/dataservice/data/device/state/OMPRoute"],
    "control": ["/dataservice/data/device/state/ControlConnection",
                "/dataservice/data/device/state/ControlConnections"],
}

# Fields the exporter reads. Reported as present/absent so a silent unit or
# spelling change is visible rather than showing up as a blank panel.
FIELDS_OF_INTEREST = {
    "interface": ["ifname", "vpn-id", "if-oper-status", "if-admin-status",
                  "rx-kbps", "tx-kbps", "speed-mbps", "color", "rx-errors",
                  "tx-errors", "rx-drops", "tx-drops", "ip-address",
                  "bandwidth-downstream", "bandwidth-upstream"],
    "tloc": ["interface", "color", "carrier", "private-ip", "public-ip",
             "operational-state"],
    "bfd": ["state", "local-color", "color", "site-id", "system-ip",
            "latency", "jitter", "loss", "uptime-date", "proto"],
    "ospf": ["neighbor-id", "router-id", "area-id", "state", "interface",
             "dead-timer", "uptime-date", "vpn-id"],
    "eigrp": ["peer-address", "as-number", "interface", "hold-time", "srtt",
              "q-count", "uptime-date", "vpn-id"],
    "route": ["prefix", "protocol", "vpn-id", "nexthop-addr",
              "nexthop-if-name", "distance", "metric"],
    "bgp": ["peer-addr", "as", "state", "prefixes-received", "vpn-id"],
    "omp": ["peer", "type", "state", "route-recv", "route-sent", "domain-id"],
    "control": ["peer-type", "state", "local-color", "remote-color", "protocol"],
}

DEVICE_KEYS = ["vdevice-name", "vdevice-host-name", "system-ip", "host-name"]


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class Client(object):
    def __init__(self):
        self.base = "https://%s:%d" % (HOST, PORT)
        self.token = None
        ctx = ssl.create_default_context()
        if not VERIFY:
            ctx.check_hostname = False
            ctx.verify_mode = ssl.CERT_NONE
        self.jar = http.cookiejar.CookieJar()
        self.opener = urllib.request.build_opener(
            urllib.request.HTTPCookieProcessor(self.jar),
            urllib.request.HTTPSHandler(context=ctx),
            NoRedirect())

    def _raw(self, path, data=None):
        hdrs = {"Accept": "application/json"}
        body = None
        if data is not None:
            body = urllib.parse.urlencode(data).encode()
            hdrs["Content-Type"] = "application/x-www-form-urlencoded"
        if self.token:
            hdrs["X-XSRF-TOKEN"] = self.token
        req = urllib.request.Request(self.base + path, data=body, headers=hdrs)
        try:
            r = self.opener.open(req, timeout=TIMEOUT)
            return r.getcode(), r.read()
        except urllib.error.HTTPError as e:
            return e.code, e.read()

    def login(self):
        st, body = self._raw("/j_security_check",
                             data={"j_username": USER, "j_password": PASS})
        if "<html" in body.decode("utf-8", "replace")[:512].lower():
            raise SystemExit("login rejected: vManage returned the login page. "
                             "Check VMANAGE_USER / VMANAGE_PASS.")
        if st not in (200, 302):
            raise SystemExit("login failed with HTTP %s" % st)
        st, tok = self._raw("/dataservice/client/token")
        if st == 200 and tok and b"<html" not in tok[:64].lower():
            self.token = tok.decode().strip()

    def logout(self):
        try:
            self._raw("/logout?nocache=1")
        except Exception:
            pass

    def rows(self, path):
        st, body = self._raw(path)
        if st != 200:
            return st, []
        try:
            payload = json.loads(body.decode("utf-8", "replace"))
        except ValueError:
            return "bad-json", []
        if isinstance(payload, dict):
            return st, payload.get("data") or []
        return st, payload if isinstance(payload, list) else []


def probe(client, signals, sample_rows):
    interface_ok = False
    devices_seen = {}

    st, devs = client.rows("/dataservice/device")
    print("=" * 74)
    print("DEVICE INVENTORY  /dataservice/device -> HTTP %s, %d rows" % (st, len(devs)))
    platforms = {}
    for d in devs:
        platforms[d.get("device-type", "?")] = platforms.get(d.get("device-type", "?"), 0) + 1
        for k in ("system-ip", "host-name"):
            if d.get(k):
                devices_seen[d[k]] = True
    for p, n in sorted(platforms.items()):
        print("    device-type=%-16s %d" % (p, n))
    print()

    for name in signals:
        print("=" * 74)
        print("SIGNAL: %s" % name.upper())
        answered = []
        for path in SIGNALS[name]:
            st, data = client.rows("%s?count=%d" % (path, COUNT))
            entity = path.rsplit("/", 1)[-1]
            mark = "OK " if data else ("-- " if st == 200 else "ERR")
            print("  [%s] %-34s HTTP %-9s rows=%d" % (mark, entity, st, len(data)))
            if data:
                answered.append((entity, data))

        if not answered:
            print("  >> NO ENTITY ANSWERED. This signal cannot be collected on "
                  "this build.")
            if name == "eigrp":
                print("     Expected on most releases: EIGRP has no bulk state "
                      "entity. The exporter\n     publishes "
                      "vmanage_protocol_data_available{protocol=\"eigrp\"} 0 "
                      "and the dashboard\n     shows 'Data not available from "
                      "current collector'.")
            print()
            continue

        if name == "interface":
            interface_ok = True

        # Which devices does each entity cover? This is the check that would
        # have caught the original bug: if two entities each cover a disjoint
        # set of routers, taking only the first one loses half the fabric.
        coverage = {}
        for entity, data in answered:
            devs_in = set()
            for r in data:
                for k in DEVICE_KEYS:
                    if r.get(k):
                        devs_in.add(str(r[k]))
                        break
            coverage[entity] = devs_in
        if len(answered) > 1:
            print("  device coverage per entity (sample of %d rows each):" % COUNT)
            for entity, devs_in in coverage.items():
                print("      %-34s %d distinct devices" % (entity, len(devs_in)))
            names = list(coverage)
            for i in range(len(names)):
                for j in range(i + 1, len(names)):
                    a, b = coverage[names[i]], coverage[names[j]]
                    if a and b and not (a & b):
                        print("      >> %s and %s are DISJOINT -- both must be "
                              "queried and merged." % (names[i], names[j]))

        fields = FIELDS_OF_INTEREST.get(name, [])
        if fields:
            for entity, data in answered:
                present, missing, nulls = [], [], []
                for f in fields:
                    have = [r for r in data if f in r]
                    if not have:
                        missing.append(f)
                    elif all(r.get(f) is None for r in have):
                        nulls.append(f)
                    else:
                        present.append(f)
                print("  %s fields:" % entity)
                print("      present : %s" % (", ".join(present) or "(none)"))
                if nulls:
                    print("      ALWAYS NULL : %s" % ", ".join(nulls))
                    print("      >> a null here becomes the label value 'None' "
                          "unless coalesced")
                if missing:
                    print("      absent  : %s" % ", ".join(missing))

        if name == "interface":
            for entity, data in answered:
                vpns, colours, speeds = {}, {}, 0
                for r in data:
                    v = r.get("vpn-id", r.get("vpnId"))
                    vpns[repr(v)] = vpns.get(repr(v), 0) + 1
                    c = r.get("color")
                    colours[repr(c)] = colours.get(repr(c), 0) + 1
                    if r.get("speed-mbps"):
                        speeds += 1
                print("  %s vpn-id distribution: %s" % (
                    entity, ", ".join("%s=%d" % kv for kv in sorted(vpns.items()))))
                print("  %s color distribution : %s" % (
                    entity, ", ".join("%s=%d" % kv for kv in sorted(colours.items()))))
                print("  %s rows with a usable speed-mbps: %d/%d  "
                      "(utilisation needs this, or a CIR in wan_links.json)"
                      % (entity, speeds, len(data)))

        if sample_rows:
            for entity, data in answered:
                print("  --- %s sample ---" % entity)
                for r in data[:sample_rows]:
                    print("      " + json.dumps(r, sort_keys=True)[:700])
        print()

    return interface_ok


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--sample", type=int, default=0,
                    help="print N raw rows per entity")
    ap.add_argument("--signal", action="append",
                    help="probe only this signal (repeatable)")
    args = ap.parse_args()

    for name, value in (("VMANAGE_HOST", HOST), ("VMANAGE_USER", USER),
                        ("VMANAGE_PASS", PASS)):
        if not value:
            raise SystemExit("missing environment variable %s" % name)

    signals = args.signal or list(SIGNALS)
    for s in signals:
        if s not in SIGNALS:
            raise SystemExit("unknown signal %r; choose from %s"
                             % (s, ", ".join(SIGNALS)))

    c = Client()
    c.login()
    print("connected to %s as %s\n" % (HOST, USER))
    try:
        ok = probe(c, signals, args.sample)
    finally:
        c.logout()

    if "interface" in signals and not ok:
        print("RESULT: no interface entity returned data. WAN panels cannot "
              "populate until this is resolved.")
        return 1
    print("RESULT: probe complete.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
