#!/usr/bin/env python3
"""Generate a site-and-device drill-down dashboard per Meraki organisation."""
from __future__ import print_function
import argparse, json, os, re, sys, urllib.request

DS = {"type": "prometheus", "uid": "prometheus"}
PCT = [{"color":"green","value":None},{"color":"#EAB839","value":70},
       {"color":"orange","value":85},{"color":"red","value":95}]

def slugify(n):
    return re.sub(r"-+","-",re.sub(r"[^a-zA-Z0-9]+","-",n).strip("-").lower()) or "org"

def orgs_from_exporter(url):
    with urllib.request.urlopen(url, timeout=15) as r:
        text = r.read().decode("utf-8","replace")
    found = {}
    for line in text.splitlines():
        if not line.startswith("meraki_"): continue
        i = re.search(r'org_id="([^"]+)"', line); n = re.search(r'org="([^"]+)"', line)
        if i and n: found[i.group(1)] = n.group(1)
    if not found: raise SystemExit("no orgs found in exporter metrics")
    return [{"id":k,"name":v,"slug":slugify(v)} for k,v in sorted(found.items(), key=lambda kv: kv[1])]

def orgs_from_file(p):
    import yaml
    raw = yaml.safe_load(open(p)) or {}
    return [{"id":str(e["id"]),"name":e["name"],"slug":e.get("slug") or slugify(e["name"])}
            for e in raw.get("organizations",[])]

def tgt(expr, legend="", rid="A", instant=False, fmt="time_series"):
    t = {"datasource":DS,"editorMode":"code","expr":expr,"refId":rid,
         "range":not instant,"instant":instant}
    if legend: t["legendFormat"] = legend
    if fmt!="time_series": t["format"] = fmt
    return t

def stat(pid,title,expr,unit,steps,x,y,w=4,h=4,graph="none",dec=None,mappings=None,vsize=30):
    d = {"unit":unit,"mappings":mappings or [],
         "thresholds":{"mode":"absolute","steps":steps},"color":{"mode":"thresholds"}}
    if dec is not None: d["decimals"]=dec
    return {"id":pid,"type":"stat","title":title,"datasource":DS,
            "gridPos":{"h":h,"w":w,"x":x,"y":y},
            "fieldConfig":{"defaults":d,"overrides":[]},
            "options":{"reduceOptions":{"calcs":["lastNotNull"],"fields":"","values":False},
                       "orientation":"auto","textMode":"auto","colorMode":"value",
                       "graphMode":graph,"justifyMode":"auto","wideLayout":True,
                       "showPercentChange":False,"percentChangeColorMode":"standard",
                       "text":{"titleSize":13,"valueSize":vsize}},
            "targets":[tgt(expr)]}

def ts(pid,title,targets,unit,x,y,w,h,steps=None,fill=16,desc=None,maxv=None):
    d = {"unit":unit,"min":0,"color":{"mode":"palette-classic"},
         "custom":{"drawStyle":"line","lineInterpolation":"smooth","lineWidth":2,
                   "fillOpacity":fill,"gradientMode":"opacity","showPoints":"never",
                   "pointSize":5,"spanNulls":900000,"axisPlacement":"auto","axisLabel":"",
                   "axisColorMode":"text","axisBorderShow":False,"axisSoftMin":0,
                   "scaleDistribution":{"type":"linear"},"barAlignment":0,
                   "insertNulls":False,
                   "hideFrom":{"legend":False,"tooltip":False,"viz":False},
                   "stacking":{"group":"A","mode":"none"},
                   "thresholdsStyle":{"mode":"dashed" if steps else "off"}},
         "mappings":[],
         "thresholds":{"mode":"absolute","steps":steps or [{"color":"green","value":None}]}}
    if maxv is not None: d["max"]=maxv
    return {"id":pid,"type":"timeseries","title":title,"datasource":DS,
            "description":desc or "","gridPos":{"h":h,"w":w,"x":x,"y":y},
            "fieldConfig":{"defaults":d,"overrides":[]},
            "options":{"legend":{"displayMode":"list","placement":"bottom",
                                 "showLegend":True,"calcs":[]},
                       "tooltip":{"mode":"multi","sort":"desc"}},
            "targets":targets}

STATUS_MAP = [{"type":"value","options":{
    "0":{"text":"Offline","color":"red","index":0},
    "0.5":{"text":"Alerting","color":"orange","index":1},
    "1":{"text":"Online","color":"green","index":2}}}]

def build(org):
    oid = org["id"]
    ORG  = 'org_id="%s"' % oid
    CTRY = 'org_id="%s", country="$country"' % oid
    SITE = 'org_id="%s", site_id="$site"' % oid
    DEV  = 'org_id="%s", site_id="$site", device_name="$device"' % oid
    P = []
    y = 0

    def row(title, yy):
        return {"id": 900 + yy, "type": "row", "title": title, "collapsed": False,
                "gridPos": {"h": 1, "w": 24, "x": 0, "y": yy}, "panels": [],
                "datasource": DS}

    # ================= COUNTRY LEVEL =================
    P.append(row("$country — estate overview", y)); y += 1
    P.append(stat(1, "Sites", 'count(meraki_site_devices_total{%s})' % CTRY,
                  "short", [{"color":"blue","value":None}], 0, y, w=4))
    P.append(stat(2, "Devices", 'sum(meraki_site_devices_total{%s})' % CTRY,
                  "short", [{"color":"blue","value":None}], 4, y, w=4))
    P.append(stat(3, "Devices Down",
                  'sum(meraki_site_devices_total{%s}) - sum(meraki_site_devices_online{%s})'
                  % (CTRY, CTRY), "short",
                  [{"color":"green","value":None},{"color":"red","value":1}], 8, y, w=4))
    P.append(stat(4, "Sites Fully Up",
                  'count(meraki_site_devices_total{%s} == on(site_id) meraki_site_devices_online{%s}) or vector(0)'
                  % (CTRY, CTRY), "short", [{"color":"green","value":None}], 12, y, w=4))
    P.append(stat(5, "WAN Circuits", 'count(meraki_uplink_util_percent{%s}) or vector(0)' % ORG,
                  "short", [{"color":"blue","value":None}], 16, y, w=4))
    P.append(stat(6, "Peak WAN Util", 'max(meraki_uplink_util_percent{%s})' % SITE,
                  "percent", PCT, 20, y, w=4, graph="area", dec=1))
    y += 4

    P.append({"id":9,"type":"table","title":"Sites in $country","datasource":DS,
        "gridPos":{"h":8,"w":24,"x":0,"y":y},
        "description":"Every site whose hostname prefix maps to this country. Sort by Down to find problem sites.",
        "fieldConfig":{"defaults":{
            "custom":{"align":"auto","cellOptions":{"type":"auto"},"inspect":False,"filterable":True},
            "mappings":[],"thresholds":{"mode":"absolute","steps":[{"color":"text","value":None}]}},
          "overrides":[{"matcher":{"id":"byName","options":"Down"},
             "properties":[{"id":"custom.cellOptions","value":{"type":"color-background"}},
                           {"id":"thresholds","value":{"mode":"absolute","steps":[
                               {"color":"green","value":None},{"color":"red","value":1}]}},
                           {"id":"custom.width","value":90}]}]},
        "options":{"showHeader":True,"cellHeight":"sm",
                   "footer":{"show":True,"reducer":["sum"],"countRows":False,
                             "fields":["Devices","Online","Down"]},
                   "sortBy":[{"desc":True,"displayName":"Down"}]},
        "targets":[tgt('meraki_site_devices_total{%s}' % CTRY, rid="A", instant=True, fmt="table"),
                   tgt('meraki_site_devices_online{%s}' % CTRY, rid="B", instant=True, fmt="table"),
                   tgt('meraki_site_devices_total{%s} - on(site_id) meraki_site_devices_online{%s}'
                       % (CTRY, CTRY), rid="C", instant=True, fmt="table")],
        "transformations":[
            {"id":"joinByField","options":{"byField":"site_id","mode":"outer"}},
            {"id":"organize","options":{
                "excludeByName":{"Time":True,"Time 1":True,"Time 2":True,"Time 3":True,
                                 "__name__":True,"__name__ 1":True,"__name__ 2":True,
                                 "job":True,"job 1":True,"job 2":True,"job 3":True,
                                 "instance":True,"instance 1":True,"instance 2":True,"instance 3":True,
                                 "org":True,"org 1":True,"org 2":True,"org 3":True,
                                 "org_id":True,"org_id 1":True,"org_id 2":True,"org_id 3":True,
                                 "country 1":True,"country 2":True,"country 3":True,
                                 "country_code 1":True,"country_code 2":True,"country_code 3":True},
                "renameByName":{"site_id":"Site","country":"Country","country_code":"CC",
                                "Value #A":"Devices","Value #B":"Online","Value #C":"Down"},
                "indexByName":{"site_id":0,"country":1,"Value #A":2,"Value #B":3,"Value #C":4}}}]})
    y += 8

    # ================= SITE LEVEL =================
    P.append(row("$site — site detail", y)); y += 1
    P.append(stat(10, "Devices", 'sum(meraki_site_devices_total{%s})' % SITE,
                  "short", [{"color":"blue","value":None}], 0, y, w=3))
    P.append(stat(11, "Online", 'sum(meraki_site_devices_online{%s})' % SITE,
                  "short", [{"color":"green","value":None}], 3, y, w=3))
    P.append(stat(12, "Not Online",
                  'sum(meraki_site_devices_total{%s}) - sum(meraki_site_devices_online{%s})'
                  % (SITE, SITE), "short",
                  [{"color":"green","value":None},{"color":"red","value":1}], 6, y, w=3))
    P.append(stat(13, "Switch Port Errors",
                  'sum(meraki_switch_ports_with_errors{%s}) or vector(0)' % SITE, "short",
                  [{"color":"green","value":None},{"color":"orange","value":1},
                   {"color":"red","value":5}], 9, y, w=3))
    P.append(stat(14, "Wired Clients",
                  'sum(meraki_switch_client_count{%s}) or vector(0)' % SITE,
                  "short", [{"color":"blue","value":None}], 12, y, w=3))
    P.append(stat(15, "PoE Draw",
                  'sum(meraki_switch_poe_draw_watts{%s}) or vector(0)' % SITE,
                  "watt", [{"color":"blue","value":None}], 15, y, w=3, dec=1))
    P.append(stat(16, "Peak Channel Util",
                  'max(meraki_ap_channel_utilization_percent{%s})' % SITE,
                  "percent", PCT, 18, y, w=3, dec=1))
    P.append(stat(17, "Peak WAN Util", 'max(meraki_uplink_util_percent{%s})' % SITE,
                  "percent", PCT, 21, y, w=3, dec=1))
    y += 4

    P.append({"id":20,"type":"table","title":"Devices at $site","datasource":DS,
        "gridPos":{"h":9,"w":14,"x":0,"y":y},
        "fieldConfig":{"defaults":{
            "custom":{"align":"auto","cellOptions":{"type":"auto"},"inspect":False,"filterable":True},
            "mappings":[],"thresholds":{"mode":"absolute","steps":[{"color":"text","value":None}]}},
          "overrides":[{"matcher":{"id":"byName","options":"Status"},
             "properties":[{"id":"mappings","value":STATUS_MAP},
                           {"id":"custom.cellOptions","value":{"type":"color-text"}},
                           {"id":"thresholds","value":{"mode":"absolute","steps":[
                               {"color":"red","value":None},{"color":"orange","value":0.5},
                               {"color":"green","value":1}]}},
                           {"id":"custom.width","value":100}]}]},
        "options":{"showHeader":True,"cellHeight":"sm",
                   "footer":{"show":False,"reducer":["sum"],"countRows":False,"fields":""},
                   "sortBy":[{"desc":False,"displayName":"Device"}]},
        "targets":[tgt('meraki_device_up{%s}' % SITE, rid="A", instant=True, fmt="table")],
        "transformations":[{"id":"organize","options":{
            "excludeByName":{"Time":True,"__name__":True,"job":True,"instance":True,
                             "org":True,"org_id":True,"network_id":True,"site_id":True,
                             "country":True,"country_code":True},
            "renameByName":{"device_name":"Device","device_role":"Role","model":"Model",
                            "product_type":"Type","serial":"Serial","network":"Network",
                            "Value":"Status"},
            "indexByName":{"device_name":0,"device_role":1,"model":2,"product_type":3,
                           "Value":4,"serial":5,"network":6}}}]})

    P.append({"id":21,"type":"piechart","title":"Device mix at $site","datasource":DS,
        "gridPos":{"h":9,"w":10,"x":14,"y":y},
        "fieldConfig":{"defaults":{"unit":"short","mappings":[],
            "color":{"mode":"palette-classic"},
            "custom":{"hideFrom":{"legend":False,"tooltip":False,"viz":False}}},
          "overrides":[]},
        "options":{"reduceOptions":{"calcs":["lastNotNull"],"fields":"","values":False},
                   "pieType":"donut","displayLabels":["name","value"],
                   "legend":{"displayMode":"list","placement":"right","showLegend":True,
                             "values":["value"]},
                   "tooltip":{"mode":"single","sort":"none"}},
        "targets":[tgt('sum by (device_role) (meraki_site_devices_by_role{%s})' % SITE,
                       "{{device_role}}")]})
    y += 9

    P.append({"id":22,"type":"state-timeline","title":"Device availability — $site",
        "datasource":DS,"gridPos":{"h":8,"w":24,"x":0,"y":y},
        "description":"Polled every 5 minutes, which is also how often Meraki refreshes this data. Shorter outages are not visible.",
        "fieldConfig":{"defaults":{
            "custom":{"lineWidth":0,"fillOpacity":85,"spanNulls":False,"insertNulls":False,
                      "hideFrom":{"legend":False,"tooltip":False,"viz":False}},
            "color":{"mode":"thresholds"},
            "thresholds":{"mode":"absolute","steps":[
                {"color":"red","value":None},{"color":"orange","value":0.5},
                {"color":"green","value":1}]},
            "mappings":STATUS_MAP},"overrides":[]},
        "options":{"mergeValues":True,"showValue":"never","alignValue":"center",
                   "rowHeight":0.85,
                   "legend":{"displayMode":"list","placement":"bottom","showLegend":True},
                   "tooltip":{"mode":"single","sort":"none"}},
        "targets":[tgt('meraki_device_up{%s}' % SITE, "{{device_name}}")]})
    y += 8

    P.append(ts(23, "WAN utilisation — $site",
                [tgt('meraki_uplink_util_percent{%s}' % SITE, "{{uplink}} · {{provider}}")],
                "percent", 0, y, 8, 8, maxv=100,
                steps=[{"color":"green","value":None},{"color":"orange","value":80},
                       {"color":"red","value":95}],
                desc="site_id here comes from capacity.yml. If this is empty while devices show, capacity.yml site_id does not match the hostname convention."))
    P.append(ts(24, "Switch port errors & warnings — $site",
                [tgt('sum(meraki_switch_ports_with_errors{%s})' % SITE, "errors", "A"),
                 tgt('sum(meraki_switch_ports_with_warnings{%s})' % SITE, "warnings", "B")],
                "short", 8, y, 8, 8, fill=20))
    P.append(ts(25, "Channel utilisation by band — $site",
                [tgt('meraki_ap_channel_utilization_percent{%s}' % SITE,
                     "{{device_name}} {{band}}GHz total", "A"),
                 tgt('meraki_ap_channel_utilization_non_wifi_percent{%s}' % SITE,
                     "{{device_name}} {{band}}GHz interference", "B")],
                "percent", 16, y, 8, 8, maxv=100,
                desc="High WiFi utilisation means you need capacity. High non-WiFi means interference, and adding APs will not help."))
    y += 8

    # ================= DEVICE LEVEL =================
    P.append(row("$device — device detail", y)); y += 1
    P.append(stat(30, "Status", 'meraki_device_up{%s}' % DEV, "short",
                  [{"color":"red","value":None},{"color":"orange","value":0.5},
                   {"color":"green","value":1}], 0, y, w=4, mappings=STATUS_MAP, vsize=24))
    P.append(stat(31, "Memory Used", 'meraki_device_memory_used_percent{%s}' % DEV,
                  "percent", PCT, 4, y, w=4, graph="area", dec=1))
    P.append(stat(32, "CPU Load (5m)", 'meraki_device_cpu_load5{%s}' % DEV, "short",
                  [{"color":"blue","value":None}], 8, y, w=4, graph="area", dec=0, vsize=24))
    P.append(stat(33, "Ports Connected",
                  'meraki_switch_ports_connected{%s}' % DEV, "short",
                  [{"color":"blue","value":None}], 12, y, w=4, vsize=24))
    P.append(stat(34, "Port Errors", 'meraki_switch_ports_with_errors{%s}' % DEV, "short",
                  [{"color":"green","value":None},{"color":"red","value":1}], 16, y, w=4, vsize=24))
    P.append(stat(35, "Clients", 'meraki_switch_client_count{%s}' % DEV, "short",
                  [{"color":"blue","value":None}], 20, y, w=4, vsize=24))
    y += 4

    P.append(ts(40, "Memory utilisation — $device",
                [tgt('meraki_device_memory_used_percent{%s}' % DEV, "{{device_name}}")],
                "percent", 0, y, 8, 8, maxv=100,
                steps=[{"color":"green","value":None},{"color":"orange","value":85}],
                desc="Available for every Meraki device type."))
    P.append(ts(41, "CPU load average — $device",
                [tgt('meraki_device_cpu_load5{%s}' % DEV, "load5")],
                "short", 8, y, 8, 8,
                desc="ACCESS POINTS ONLY. Meraki exposes no CPU metric for MS switches or MX appliances, so this is empty for those. It is a load average, not a percentage."))
    P.append(ts(42, "Switch ports & PoE — $device",
                [tgt('meraki_switch_ports_connected{%s}' % DEV, "connected", "A"),
                 tgt('meraki_switch_ports_total{%s}' % DEV, "total", "B"),
                 tgt('meraki_switch_poe_draw_watts{%s}' % DEV, "PoE watts", "C")],
                "short", 16, y, 8, 8, fill=10,
                desc="Switches only. Aggregated per switch rather than per port -- per-port series across this estate would be six figures of cardinality."))
    y += 8

    P.append({"id":50,"type":"row","title":"Collection health","collapsed":True,
        "gridPos":{"h":1,"w":24,"x":0,"y":y},"datasource":DS,
        "panels":[
            ts(51, "API request rate — this org",
               [tgt('sum by (endpoint) (rate(meraki_api_requests_total{%s}[10m]))' % ORG,
                    "{{endpoint}}", "A"),
                tgt('vector(5)', "self-imposed cap 5/s", "B")],
               "reqps", 0, y+1, 12, 7, fill=8,
               desc="Meraki allows 10 req/s per ORGANISATION. Tiered polling keeps the average far below the cap; brief peaks during the 15-minute switch sweep are expected."),
            stat(52, "Rate limit hits (24h)",
                 'sum(increase(meraki_rate_limited_total{%s}[24h])) or vector(0)' % ORG,
                 "short", [{"color":"green","value":None},{"color":"red","value":1}],
                 12, y+1, w=4, h=7),
            stat(53, "Unparsed hostnames",
                 'sum(increase(meraki_device_name_unparsed_total{%s}[24h])) or vector(0)' % ORG,
                 "short", [{"color":"green","value":None},{"color":"orange","value":1}],
                 16, y+1, w=4, h=7),
            stat(54, "Data age",
                 'time() - max(meraki_last_successful_collection_timestamp_seconds{%s})' % ORG,
                 "s", [{"color":"green","value":None},{"color":"#EAB839","value":120},
                       {"color":"red","value":600}], 20, y+1, w=4, h=7, dec=0, vsize=24),
        ]})

    # Three-level chain: Org (fixed per dashboard) > Country > Site > Device.
    # Each level filters the next, so choosing Austria narrows the site list to
    # Austrian sites, and choosing a site narrows the device list to that site.
    # country is derived from the site_id prefix (US-3303 -> US -> United States).
    country_q = 'label_values(meraki_site_devices_total{org_id="%s"}, country)' % oid
    site_q = ('label_values(meraki_site_devices_total{org_id="%s", '
              'country="$country"}, site_id)' % oid)
    dev_q = ('label_values(meraki_device_up{org_id="%s", site_id="$site"}, '
             'device_name)' % oid)

    def var(name, label, q):
        return {"name":name,"label":label,"type":"query","datasource":DS,
                "definition":q,"query":{"qryType":1,"query":q,"refId":"var-"+name},
                "multi":False,"includeAll":False,
                "current":{"selected":False,"text":"","value":""},
                "refresh":2,"sort":1,"hide":0,"options":[]}

    return {
        "uid": ("site-%s" % org["slug"])[:40],
        "title": "Site Observability — %s" % org["name"],
        "description": ("Country > Site > Device drill-down for %s. site_id is "
                        "derived from the device hostname (AT-7689-ASW01 -> "
                        "AT-7689) and country from its ISO prefix."
                        % org["name"]),
        "tags": ["wan", "meraki", "observability", org["slug"]],
        "timezone": "browser", "editable": True, "graphTooltip": 1,
        "schemaVersion": 39, "version": 1, "refresh": "5m",
        "time": {"from": "now-24h", "to": "now"},
        "timepicker": {"refresh_intervals": ["1m", "5m", "15m", "30m", "1h"]},
        "fiscalYearStartMonth": 0, "links": [],
        "annotations": {"list": [{"builtIn": 1,
            "datasource": {"type": "grafana", "uid": "-- Grafana --"},
            "enable": True, "hide": True, "iconColor": "rgba(0, 211, 255, 1)",
            "name": "Annotations & Alerts", "type": "dashboard"}]},
        "templating": {"list": [var("country", "Country", country_q),
                                var("site", "Site", site_q),
                                var("device", "Device", dev_q)]},
        "panels": P,
    }


def main():
    ap = argparse.ArgumentParser()
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--from-exporter", metavar="URL")
    g.add_argument("--orgs", metavar="FILE")
    ap.add_argument("--out", default="dashboards")
    a = ap.parse_args()
    orgs = orgs_from_exporter(a.from_exporter) if a.from_exporter else orgs_from_file(a.orgs)
    print("Found %d organisation(s):"%len(orgs))
    for o in orgs: print("   %-26s %-22s -> %s"%(o["name"],o["id"],o["slug"]))
    print()
    for o in orgs:
        d = os.path.join(a.out,o["slug"]); os.makedirs(d,exist_ok=True)
        p = os.path.join(d,"site-%s.json"%o["slug"])
        json.dump(build(o),open(p,"w"),indent=2)
        print("  wrote %s"%p)
    print("\n%d site dashboards generated."%len(orgs))
    return 0

if __name__ == "__main__":
    sys.exit(main())

