#!/usr/bin/env python3
"""
Determine, properly, whether vManage holds interface throughput.

WHY THIS SUPERSEDES probe-vmanage-stats.py
  That probe sent `?count=200` to every statistics endpoint and got HTTP 400
  from all twelve. It concluded "no data". That conclusion was unsound.

  The statistics API is not the state API. State endpoints
  (/dataservice/data/device/state/...) accept ?count=N and return rows.
  Statistics endpoints expect a TIME-RANGE QUERY -- either a `query=` JSON
  parameter or a POST body -- and reject anything else with 400. A uniform
  400 across twelve unrelated paths is the signature of a malformed request,
  not of an empty database.

  400 means "you asked wrongly". It does not mean "there is nothing here".

WHAT THIS ASKS, IN ORDER
  1. Is statistics collection even switched on? vManage exposes its own
     configuration for this, which answers the question directly instead of
     inferring it from failed queries.
  2. Do the bulk statistics endpoints return data when given a correctly
     formed time-range query?
  3. Does the aggregation API work, which is cheaper and often enabled when
     raw retrieval is not?
  4. As a last resort on ONE device only: does the per-device endpoint hold
     data? This proves the data exists somewhere even if bulk access does
     not. It is deliberately limited to a single device -- polling this
     across 723 edges traverses the control plane per call and would
     destabilise vManage.

Read-only throughout. Nothing here changes vManage configuration.

Usage:
    set -a; source /etc/network-telemetry/exporters.env; set +a
    python3 probe-vmanage-stats2.py
    python3 probe-vmanage-stats2.py --sample 2
"""

import argparse
import http.cookiejar
import json
import os
import ssl
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

HOST = os.environ.get("VMANAGE_HOST", "").strip()
PORT = int(os.environ.get("VMANAGE_PORT", "443"))
USER = os.environ.get("VMANAGE_USER", "").strip()
PASS = os.environ.get("VMANAGE_PASS", "")
VERIFY = os.environ.get("VMANAGE_VERIFY_TLS", "false").lower() == "true"
TIMEOUT = int(os.environ.get("REQUEST_TIMEOUT_SECONDS", "60"))
GAP = float(os.environ.get("REQUEST_GAP_SECONDS", "0.4"))
HOURS = int(os.environ.get("PROBE_HOURS", "24"))


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class VManage(object):
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

    def _raw(self, path, data=None, json_body=None):
        hdrs = {"Accept": "application/json"}
        body = None
        if json_body is not None:
            body = json.dumps(json_body).encode()
            hdrs["Content-Type"] = "application/json"
        elif data is not None:
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
            raise SystemExit("login rejected -- check credentials")
        if not any(c.name == "JSESSIONID" for c in self.jar):
            raise SystemExit("no JSESSIONID returned")
        st, tok = self._raw("/dataservice/client/token")
        if st == 200 and tok:
            cand = tok.decode("utf-8", "replace").strip()
            if "<html" not in cand.lower() and len(cand) < 4096:
                self.token = cand

    def logout(self):
        try:
            self._raw("/logout?nocache=%d" % int(time.time()))
        except Exception:
            pass

    def call(self, path, json_body=None):
        """Return (status, parsed, error_text). Keeps the error body, because
        vManage explains a 400 in it and that explanation is the point."""
        st, body = self._raw(path, json_body=json_body)
        time.sleep(GAP)
        text = body.decode("utf-8", "replace") if body else ""
        if st != 200:
            return st, None, text[:400]
        if text.lstrip().lower().startswith("<html"):
            return "auth-html", None, ""
        try:
            return st, json.loads(text), ""
        except ValueError:
            return "bad-json", None, text[:200]


def rows(p):
    if not p:
        return []
    if isinstance(p, dict):
        return p.get("data") or []
    return p if isinstance(p, list) else []


def sep(t):
    print("\n" + "=" * 74)
    print(t)


# ---------------------------------------------------------------------------
# A correctly formed vManage statistics query.
# ---------------------------------------------------------------------------
# The shape vManage expects: a rule set with an entry_time rule using the
# last_n_hours operator. This is what the GUI itself sends when you open a
# statistics chart, which is why it is the right thing to imitate.
def time_query(hours, extra_rules=None):
    rules = [{"value": [str(hours)], "field": "entry_time",
              "type": "date", "operator": "last_n_hours"}]
    if extra_rules:
        rules.extend(extra_rules)
    return {"query": {"condition": "AND", "rules": rules}}


def q_param(path, body):
    return path + "?query=" + urllib.parse.quote(json.dumps(body))


def show(label, st, parsed, err, sample=0, want=None):
    data = rows(parsed)
    if st == 200 and data:
        keys = set()
        for r in data[:100]:
            if isinstance(r, dict):
                keys.update(r.keys())
        print("  [OK ] %-52s rows=%d" % (label, len(data)))
        if want:
            present = [f for f in want if f in keys]
            missing = [f for f in want if f not in keys]
            print("        present: %s" % (", ".join(present) or "(none of the wanted fields)"))
            if missing:
                print("        absent : %s" % ", ".join(missing))
        else:
            print("        fields : %s" % ", ".join(sorted(keys))[:300])
        for r in data[:sample]:
            print("        " + json.dumps(r, sort_keys=True)[:500])
        return True
    if st == 200:
        print("  [EMPTY] %-50s HTTP 200 but zero rows" % label)
        print("        -> endpoint exists and the query was accepted;")
        print("           the database simply holds nothing for this window.")
        return False
    print("  [ERR] %-52s HTTP %s" % (label, st))
    if err:
        print("        vManage said: %s" % err.replace("\n", " ")[:300])
    return False


IFACE_WANT = ["rx_kbps", "tx_kbps", "rx_octets", "tx_octets", "interface",
              "vpn_id", "vdevice_name", "down_capacity", "up_capacity"]
APPR_WANT = ["latency", "jitter", "loss_percentage", "local_color",
             "remote_color", "vdevice_name", "name"]


def probe_settings(vm):
    """Ask vManage directly whether it is collecting statistics.

    This is the question that actually matters. Every 400 in the previous
    probe is explained one way if collection is disabled and a completely
    different way if it is enabled, and guessing between those two costs a
    deployment cycle each time.
    """
    sep("1. IS STATISTICS COLLECTION ENABLED?")
    for path in ("/dataservice/statistics/settings/status",
                 "/dataservice/management/elasticsearch/index/size",
                 "/dataservice/statistics/settings/disable"):
        st, parsed, err = vm.call(path)
        if st == 200 and parsed is not None:
            print("  [OK ] %s" % path)
            print("        %s" % json.dumps(parsed, sort_keys=True)[:600])
        else:
            print("  [ERR] %-52s HTTP %s" % (path.split("/")[-1], st))
            if err:
                print("        %s" % err.replace("\n", " ")[:200])


def probe_bulk(vm, sample):
    sep("2. BULK STATISTICS WITH A PROPER TIME QUERY (last %dh)" % HOURS)
    body = time_query(HOURS)

    targets = [
        ("interfacestatistics (GET query)",
         q_param("/dataservice/data/device/statistics/interfacestatistics", body),
         None, IFACE_WANT),
        ("statistics/interface (GET query)",
         q_param("/dataservice/statistics/interface", body), None, IFACE_WANT),
        ("interfacestatistics/page (POST)",
         "/dataservice/data/device/statistics/interfacestatistics/page",
         body, IFACE_WANT),
        ("approutestatsstatistics (GET query)",
         q_param("/dataservice/data/device/statistics/approutestatsstatistics", body),
         None, APPR_WANT),
        ("statistics/approute (GET query)",
         q_param("/dataservice/statistics/approute", body), None, APPR_WANT),
    ]

    winners = []
    for label, path, jbody, want in targets:
        st, parsed, err = vm.call(path, json_body=jbody)
        if show(label, st, parsed, err, sample, want):
            winners.append((label, path))
    return winners


def probe_aggregation(vm, sample):
    """Aggregation is cheaper than raw retrieval and is sometimes the only
    statistics path left open on a controller with tight retention."""
    sep("3. AGGREGATION API")
    body = time_query(HOURS)
    body["aggregation"] = {
        "field": [{"property": "vdevice_name", "sequence": 1, "size": 10}],
        "metrics": [{"property": "rx_kbps", "type": "avg"},
                    {"property": "tx_kbps", "type": "avg"}],
    }
    for label, path in (
        ("statistics/interface/aggregation",
         q_param("/dataservice/statistics/interface/aggregation", body)),
        ("interfacestatistics/aggregation",
         q_param("/dataservice/data/device/statistics/interfacestatistics/aggregation", body)),
    ):
        st, parsed, err = vm.call(path)
        show(label, st, parsed, err, sample)


def probe_single_device(vm, sample):
    """Prove the data exists on ONE device. Never do this fleet-wide."""
    sep("4. SINGLE-DEVICE REALTIME (proof of existence only)")
    st, parsed, err = vm.call("/dataservice/device")
    devs = [d for d in rows(parsed)
            if str(d.get("device-type", "")).lower() in ("vedge", "cedge")
            and str(d.get("reachability", "")).lower() == "reachable"]
    if not devs:
        print("  no reachable vEdge/cEdge found in inventory")
        return
    d = devs[0]
    did = d.get("deviceId") or d.get("system-ip")
    print("  using device %s (%s)  -- ONE device, not the fleet"
          % (d.get("host-name"), did))
    for label, path in (
        ("interface/stats", "/dataservice/device/interface/stats?deviceId=%s" % did),
        ("interface (realtime)", "/dataservice/device/interface?deviceId=%s" % did),
        ("control/localproperties",
         "/dataservice/device/control/localproperties?deviceId=%s" % did),
    ):
        st, parsed, err = vm.call(path)
        show(label, st, parsed, err, sample)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--sample", type=int, default=0)
    args = ap.parse_args()

    for n, v in (("VMANAGE_HOST", HOST), ("VMANAGE_USER", USER),
                 ("VMANAGE_PASS", PASS)):
        if not v:
            raise SystemExit("missing environment: %s" % n)

    vm = VManage()
    vm.login()
    print("connected to %s as %s" % (HOST, USER))
    try:
        probe_settings(vm)
        winners = probe_bulk(vm, args.sample)
        probe_aggregation(vm, args.sample)
        probe_single_device(vm, args.sample)

        sep("VERDICT")
        if winners:
            print("  Statistics ARE reachable. Collector should use:")
            for label, path in winners:
                print("    %s" % label)
            print("\n  Next step: wire the WAN collector onto the bulk path")
            print("  above, keyed by vdevice_name + interface, and join it to")
            print("  ControlWanInterface for colour/carrier/state.")
        else:
            print("  No statistics path returned data even with a correct")
            print("  query. Read section 1 above -- if collection is disabled,")
            print("  this is a vManage configuration change, not a code fix:")
            print("    Administration > Settings > Statistics Configuration")
            print("  If it is enabled and still empty, retention may be zero")
            print("  or the index may have been purged.")
            print("\n  Regardless: ControlWanInterface already gives you WAN")
            print("  link inventory, colour, carrier and up/down for 1,063")
            print("  devices. That is worth shipping now, with throughput")
            print("  added later from whichever source proves available.")
    finally:
        vm.logout()
    return 0


if __name__ == "__main__":
    sys.exit(main())
