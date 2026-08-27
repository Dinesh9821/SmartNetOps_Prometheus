#!/usr/bin/env python3
"""
Meraki organisation-level WAN uplink exporter for Prometheus.

Polls Meraki Dashboard API org-wide endpoints on a background thread and
caches the results. The /metrics endpoint serves the cache instantly and
NEVER triggers an API call.

This separation is the whole point: Meraki allows only 10 requests/second
per organisation. If scraping drove polling, the API call rate would become
a function of how many Prometheus servers scrape this exporter.

Endpoints used (all organisation-wide, one call covers every network):
  - getOrganizationApplianceUplinksUsageByNetwork  -> bytes sent/received
  - getOrganizationApplianceUplinkStatuses         -> up/down state
  - getOrganizationDevicesUplinksLossAndLatency    -> loss % and latency ms
"""

import json
import logging
import os
import re
import signal
import sys
import threading
import time
from typing import Any, Dict, List, Optional

import meraki
import yaml
from prometheus_client import Counter, Gauge, Histogram, start_http_server

# ----------------------------------------------------------------------------
# Configuration
# ----------------------------------------------------------------------------

API_KEY = os.environ.get("MERAKI_API_KEY", "").strip()
ORG_IDS = [o.strip() for o in os.environ.get("MERAKI_ORG_IDS", "").split(",") if o.strip()]
LISTEN_PORT = int(os.environ.get("EXPORTER_PORT", "9822"))
POLL_INTERVAL = int(os.environ.get("POLL_INTERVAL_SECONDS", "60"))
TIMESPAN = int(os.environ.get("TIMESPAN_SECONDS", "300"))
ORG_RATE_LIMIT = int(os.environ.get("MERAKI_ORG_RATE_LIMIT", "5"))
# Collection is tiered by how fast each signal actually changes. Polling a
# slow-moving signal on a fast clock spends API budget for no information.
#
#   T1  60s   WAN uplink throughput/status      3 calls per org
#   T2  300s  device availability, memory, CPU  ~6 calls per org
#             (availabilities data itself only refreshes every 5 min, so
#              polling faster than this returns identical values)
#   T3  900s  switch port aggregates, wireless  many pages -- see below
#   T4  3600s network inventory
COLLECT_DEVICES = os.environ.get("COLLECT_DEVICE_HEALTH", "true").lower() == "true"
COLLECT_SWITCH = os.environ.get("COLLECT_SWITCH_PORTS", "true").lower() == "true"
COLLECT_WIRELESS = os.environ.get("COLLECT_WIRELESS", "true").lower() == "true"
DEVICE_CYCLE = int(os.environ.get("DEVICE_POLL_INTERVAL_SECONDS", "300"))
SLOW_CYCLE = int(os.environ.get("SLOW_POLL_INTERVAL_SECONDS", "900"))

# getOrganizationSwitchPortsStatusesBySwitch caps perPage at 20 (default 10),
# so a 1,000-switch org costs ~50 requests per sweep. That is affordable on a
# 900s cycle but would be ruinous at 60s -- hence the separate slow tier.
SWITCH_PER_PAGE = int(os.environ.get("SWITCH_PER_PAGE", "20"))

# Uplink bandwidth is read from Meraki itself rather than a hand-maintained
# file. The endpoint is per-network, so it runs on its own hourly cycle --
# shaping configuration changes far more rarely than anything else here.
CAPACITY_CYCLE = int(os.environ.get("CAPACITY_POLL_INTERVAL_SECONDS", "3600"))

# The memory-usage endpoint accepts only certain interval values and rejects
# anything else with a 400 "invalid interval" -- it is not a free-form number
# of seconds. 300s is accepted and finer than the device cycle requires.
MEMORY_INTERVAL = int(os.environ.get("MEMORY_INTERVAL_SECONDS", "300"))
MEMORY_TIMESPAN = int(os.environ.get("MEMORY_TIMESPAN_SECONDS", "3600"))
COLLECT_INVENTORY = os.environ.get("COLLECT_INVENTORY", "true").lower() == "true"

# Site IDs begin with an ISO 3166-1 alpha-2 country code (US-3303 -> United
# States, AT-7689 -> Austria). Mapping it here rather than in the dashboard
# keeps the label available to alerting and to any future consumer.
ISO_COUNTRY = {
 "AD":"Andorra","AE":"United Arab Emirates","AF":"Afghanistan","AG":"Antigua and Barbuda",
 "AL":"Albania","AM":"Armenia","AO":"Angola","AR":"Argentina","AT":"Austria",
 "AU":"Australia","AZ":"Azerbaijan","BA":"Bosnia and Herzegovina","BB":"Barbados",
 "BD":"Bangladesh","BE":"Belgium","BF":"Burkina Faso","BG":"Bulgaria","BH":"Bahrain",
 "BI":"Burundi","BJ":"Benin","BN":"Brunei","BO":"Bolivia","BR":"Brazil","BS":"Bahamas",
 "BW":"Botswana","BY":"Belarus","BZ":"Belize","CA":"Canada","CD":"DR Congo",
 "CF":"Central African Republic","CG":"Congo","CH":"Switzerland","CI":"Cote d Ivoire",
 "CL":"Chile","CM":"Cameroon","CN":"China","CO":"Colombia","CR":"Costa Rica",
 "CU":"Cuba","CV":"Cabo Verde","CY":"Cyprus","CZ":"Czechia","DE":"Germany",
 "DJ":"Djibouti","DK":"Denmark","DO":"Dominican Republic","DZ":"Algeria",
 "EC":"Ecuador","EE":"Estonia","EG":"Egypt","ER":"Eritrea","ES":"Spain",
 "ET":"Ethiopia","FI":"Finland","FJ":"Fiji","FR":"France","GA":"Gabon",
 "GB":"United Kingdom","GE":"Georgia","GH":"Ghana","GM":"Gambia","GN":"Guinea",
 "GQ":"Equatorial Guinea","GR":"Greece","GT":"Guatemala","GY":"Guyana",
 "HK":"Hong Kong","HN":"Honduras","HR":"Croatia","HT":"Haiti","HU":"Hungary",
 "ID":"Indonesia","IE":"Ireland","IL":"Israel","IN":"India","IQ":"Iraq",
 "IR":"Iran","IS":"Iceland","IT":"Italy","JM":"Jamaica","JO":"Jordan",
 "JP":"Japan","KE":"Kenya","KG":"Kyrgyzstan","KH":"Cambodia","KR":"South Korea",
 "KW":"Kuwait","KZ":"Kazakhstan","LA":"Laos","LB":"Lebanon","LK":"Sri Lanka",
 "LR":"Liberia","LS":"Lesotho","LT":"Lithuania","LU":"Luxembourg","LV":"Latvia",
 "LY":"Libya","MA":"Morocco","MC":"Monaco","MD":"Moldova","ME":"Montenegro",
 "MG":"Madagascar","MK":"North Macedonia","ML":"Mali","MM":"Myanmar","MN":"Mongolia",
 "MO":"Macao","MR":"Mauritania","MT":"Malta","MU":"Mauritius","MV":"Maldives",
 "MW":"Malawi","MX":"Mexico","MY":"Malaysia","MZ":"Mozambique","NA":"Namibia",
 "NE":"Niger","NG":"Nigeria","NI":"Nicaragua","NL":"Netherlands","NO":"Norway",
 "NP":"Nepal","NZ":"New Zealand","OM":"Oman","PA":"Panama","PE":"Peru",
 "PG":"Papua New Guinea","PH":"Philippines","PK":"Pakistan","PL":"Poland",
 "PR":"Puerto Rico","PS":"Palestine","PT":"Portugal","PY":"Paraguay","QA":"Qatar",
 "RO":"Romania","RS":"Serbia","RU":"Russia","RW":"Rwanda","SA":"Saudi Arabia",
 "SD":"Sudan","SE":"Sweden","SG":"Singapore","SI":"Slovenia","SK":"Slovakia",
 "SL":"Sierra Leone","SN":"Senegal","SO":"Somalia","SR":"Suriname","SV":"El Salvador",
 "SY":"Syria","SZ":"Eswatini","TD":"Chad","TG":"Togo","TH":"Thailand",
 "TJ":"Tajikistan","TM":"Turkmenistan","TN":"Tunisia","TR":"Turkiye","TT":"Trinidad and Tobago",
 "TW":"Taiwan","TZ":"Tanzania","UA":"Ukraine","UG":"Uganda","US":"United States",
 "UY":"Uruguay","UZ":"Uzbekistan","VE":"Venezuela","VN":"Vietnam","YE":"Yemen",
 "ZA":"South Africa","ZM":"Zambia","ZW":"Zimbabwe",
}

# Site ID is derived from the device hostname. Default matches names like
# "AT-7689-ASW01" -> site_id "AT-7689", role "ASW", index "01".
# Override for other conventions; must contain a named group "site_id".
# Site ID is the first two dash-separated tokens of the hostname:
#   AT-5789-ASD01   -> AT-5789
#   IN-PN-001-SD01  -> IN-PN
#   US-3303-ASW01-2 -> US-3303
# Everything after the second token is ignored. No regex to tune, and nothing
# lands in "unknown" as long as the first two tokens are present.
SITES_FILE = os.environ.get("SITES_FILE", "/config/sites.json")

# Hostnames with no site code fall back to the Meraki network name, which
# generally does follow the convention.
NETWORK_FALLBACK = os.environ.get("SITE_NETWORK_FALLBACK", "true").lower() == "true"

# Region by ISO country code, used when a site is absent from sites.json.
# The supplied spreadsheet covers only prefixes M-Z, so this carries much of
# the estate. Anything unlisted defaults to EMEA (Europe, Middle East, Africa).
CC_REGION = {
 "US":"AMER","CA":"AMER","MX":"AMER","BR":"AMER","AR":"AMER","CL":"AMER",
 "CO":"AMER","PE":"AMER","VE":"AMER","EC":"AMER","UY":"AMER","PY":"AMER",
 "BO":"AMER","CR":"AMER","PA":"AMER","GT":"AMER","DO":"AMER","PR":"AMER",
 "HN":"AMER","NI":"AMER","SV":"AMER","JM":"AMER","TT":"AMER","BS":"AMER",
 "AU":"APAC","NZ":"APAC","CN":"APAC","HK":"APAC","MO":"APAC","TW":"APAC",
 "JP":"APAC","KR":"APAC","IN":"APAC","SG":"APAC","MY":"APAC","TH":"APAC",
 "VN":"APAC","PH":"APAC","ID":"APAC","BD":"APAC","PK":"APAC","LK":"APAC",
 "NP":"APAC","MM":"APAC","KH":"APAC","LA":"APAC","MN":"APAC","BN":"APAC",
 "FJ":"APAC","PG":"APAC","MV":"APAC",
}
DEFAULT_REGION = os.environ.get("DEFAULT_REGION", "EMEA")
CAPACITY_FILE = os.environ.get("CAPACITY_FILE", "/config/capacity.yml")
LOG_LEVEL = os.environ.get("LOG_LEVEL", "INFO").upper()

logging.basicConfig(
    level=getattr(logging, LOG_LEVEL, logging.INFO),
    format="%(asctime)s %(levelname)-7s %(name)s %(message)s",
)
log = logging.getLogger("meraki-exporter")

# Silence the SDK's own verbose per-request logging; we do our own.
logging.getLogger("meraki").setLevel(logging.WARNING)
# httpx logs every request at INFO. Across four orgs that is ~60 lines a
# minute, which buries the exporter's own messages.
logging.getLogger("httpx").setLevel(logging.WARNING)
logging.getLogger("httpcore").setLevel(logging.WARNING)

# ----------------------------------------------------------------------------
# Metric definitions
#
# Label set is deliberately bounded. No free-text fields (device notes,
# network tags) become labels -- every edit to such a field would create a
# brand new time series.
# ----------------------------------------------------------------------------

UPLINK_LABELS = ["org", "org_id", "network", "network_id", "serial", "uplink"]

sent_bps = Gauge(
    "meraki_uplink_sent_bytes_per_second",
    "Egress throughput on a Meraki WAN uplink, averaged over the collection timespan",
    UPLINK_LABELS,
)
recv_bps = Gauge(
    "meraki_uplink_received_bytes_per_second",
    "Ingress throughput on a Meraki WAN uplink, averaged over the collection timespan",
    UPLINK_LABELS,
)
uplink_status = Gauge(
    "meraki_uplink_status",
    "Uplink state: 1=active, 0.5=ready, 0=failed/connecting/not connected",
    UPLINK_LABELS,
)
uplink_status_info = Gauge(
    "meraki_uplink_status_info",
    "Uplink state as a label (always 1); use for display, not arithmetic",
    UPLINK_LABELS + ["status"],
)
loss_percent = Gauge(
    "meraki_uplink_loss_percent",
    "Packet loss percentage measured by Meraki to its cloud",
    UPLINK_LABELS,
)
latency_ms = Gauge(
    "meraki_uplink_latency_milliseconds",
    "Latency in milliseconds measured by Meraki to its cloud",
    UPLINK_LABELS,
)

# Capacity is a METRIC, not a label -- label values are strings and cannot
# participate in PromQL arithmetic. Joined at query time with on(serial,uplink).
capacity_bps = Gauge(
    "meraki_uplink_capacity_bits_per_second",
    "Contracted circuit bandwidth (CIR) for a Meraki uplink, from static config",
    ["serial", "uplink", "circuit_id", "provider", "site_id",
     "region", "country", "priority"],
)

# --- device health ---------------------------------------------------------
#
# site_id and device_role are PARSED FROM THE HOSTNAME, not supplied by Meraki.
# Meraki has no concept of a site beyond its network object, so the naming
# convention is the only source of that grouping.

DEVICE_LABELS = ["org", "org_id", "region", "country", "site_id", "priority",
                 "network", "network_id", "device_name", "serial", "model",
                 "product_type", "device_role"]
SITE_LABELS = ["org", "org_id", "region", "country", "site_id", "priority"]

device_up = Gauge(
    "meraki_device_up",
    "1 if the device is online, 0 if offline or alerting",
    DEVICE_LABELS,
)
device_status_info = Gauge(
    "meraki_device_status_info",
    "Device status as a label (always 1). online/alerting/offline/dormant",
    DEVICE_LABELS + ["status"],
)
device_memory_used_bytes = Gauge(
    "meraki_device_memory_used_bytes",
    "Median memory used by the device over the collection interval",
    DEVICE_LABELS,
)
device_memory_free_bytes = Gauge(
    "meraki_device_memory_free_bytes",
    "Median memory free on the device over the collection interval",
    DEVICE_LABELS,
)
device_memory_used_percent = Gauge(
    "meraki_device_memory_used_percent",
    "Peak memory utilisation percentage over the collection interval",
    DEVICE_LABELS,
)
device_cpu_load5 = Gauge(
    "meraki_device_cpu_load5",
    "5-minute CPU load average, WIRELESS ACCESS POINTS ONLY. This is the raw "
    "value returned by the Meraki API -- a load average, not a percentage. "
    "Meraki exposes no CPU metric at all for MS switches or MX appliances.",
    DEVICE_LABELS,
)
device_cpu_count = Gauge(
    "meraki_device_cpu_count",
    "Number of CPU cores reported. Divide cpu_load5 by this for per-core load.",
    DEVICE_LABELS,
)

# --- site rollups ---
site_devices_total = Gauge(
    "meraki_site_devices_total", "Devices at a site, derived from hostname parsing",
    SITE_LABELS,
)
site_devices_online = Gauge(
    "meraki_site_devices_online", "Devices online at a site", SITE_LABELS,
)
site_devices_by_role = Gauge(
    "meraki_site_devices_by_role", "Devices at a site broken down by role",
    SITE_LABELS + ["device_role", "product_type"],
)

# --- switch port aggregates -------------------------------------------------
#
# PER-SWITCH, NOT PER-PORT. A 1,000-switch estate with 48 ports each would be
# ~192,000 series at per-port granularity, for data almost nobody queries.
# Aggregates answer "is anything wrong on this switch" at ~6,000 series.
SWITCH_LABELS = ["org", "org_id", "region", "country", "site_id", "priority",
                 "device_name", "serial", "model"]
switch_ports_total = Gauge("meraki_switch_ports_total",
                           "Ports on the switch", SWITCH_LABELS)
switch_ports_connected = Gauge("meraki_switch_ports_connected",
                               "Ports with a link up", SWITCH_LABELS)
switch_ports_errors = Gauge("meraki_switch_ports_with_errors",
                            "Ports reporting errors", SWITCH_LABELS)
switch_ports_warnings = Gauge("meraki_switch_ports_with_warnings",
                              "Ports reporting warnings", SWITCH_LABELS)
switch_poe_watts = Gauge("meraki_switch_poe_draw_watts",
                         "Total PoE draw across the switch", SWITCH_LABELS)
switch_clients = Gauge("meraki_switch_client_count",
                       "Clients seen across all switch ports", SWITCH_LABELS)

# --- wireless ---------------------------------------------------------------
WIRELESS_LABELS = DEVICE_LABELS + ["band"]
ap_channel_util = Gauge("meraki_ap_channel_utilization_percent",
                        "Average channel utilisation for the band", WIRELESS_LABELS)
ap_channel_util_wifi = Gauge("meraki_ap_channel_utilization_wifi_percent",
                             "Channel utilisation attributable to WiFi traffic",
                             WIRELESS_LABELS)
ap_channel_util_non_wifi = Gauge("meraki_ap_channel_utilization_non_wifi_percent",
                                 "Channel utilisation from non-WiFi interference",
                                 WIRELESS_LABELS)

device_name_via_network = Counter(
    "meraki_device_name_via_network_total",
    "Devices whose site was recovered from the network name because the "
    "hostname carried no site code",
    ["org_id"],
)

device_name_unparsed = Counter(
    "meraki_device_name_unparsed_total",
    "Device hostnames that did not match SITE_NAME_REGEX; these get "
    "site_id=unknown and will not appear under any site",
    ["org_id"],
)

# --- capacity provenance ------------------------------------------------
#
# Where each circuit's CIR came from. "meraki" means the appliance's own
# traffic-shaping limit, "file" means capacity.yml, "none" means no CIR is
# known and therefore NO utilisation percentage is produced for it.
# Charting this is how you see monitoring coverage rather than assuming it.
capacity_source = Gauge(
    "meraki_uplink_capacity_source",
    "1 for the source that supplied this circuit's CIR",
    ["org", "org_id", "region", "country", "site_id", "serial", "uplink", "source"],
)
uplinks_without_capacity = Gauge(
    "meraki_uplinks_without_capacity",
    "Uplinks carrying traffic with no known CIR, so no utilisation is calculated",
    ["org", "org_id", "region"],
)

# --- inventory ----------------------------------------------------------
INV_LABELS = ["org", "org_id", "region", "country", "site_id", "priority",
              "network", "device_name", "serial", "model", "product_type",
              "firmware", "device_role"]

inventory_device = Gauge(
    "meraki_inventory_device",
    "One series per claimed device. Value is 1 when assigned to a network, "
    "0 when claimed but unassigned (spare or awaiting deployment).",
    INV_LABELS,
)
inventory_by_model = Gauge(
    "meraki_inventory_by_model", "Device count by model",
    ["org", "org_id", "region", "product_type", "model"],
)
inventory_by_firmware = Gauge(
    "meraki_inventory_by_firmware", "Device count by firmware version",
    ["org", "org_id", "product_type", "firmware"],
)
inventory_unassigned = Gauge(
    "meraki_inventory_unassigned_total",
    "Claimed devices not assigned to any network",
    ["org", "org_id", "product_type"],
)
inventory_total = Gauge(
    "meraki_inventory_total", "Claimed devices in the organisation",
    ["org", "org_id", "product_type"],
)
site_priority_info = Gauge(
    "meraki_site_priority_info",
    "1 per site, labelled with its business priority from the site register",
    ["org", "org_id", "region", "country", "site_id", "priority"],
)

# --- exporter self-observability ---

api_requests = Counter(
    "meraki_api_requests_total",
    "Meraki Dashboard API requests issued by this exporter",
    ["org_id", "endpoint", "outcome"],
)
api_duration = Histogram(
    "meraki_api_request_duration_seconds",
    "Duration of Meraki Dashboard API calls",
    ["org_id", "endpoint"],
    buckets=(0.5, 1, 2, 5, 10, 20, 30, 60),
)
rate_limited = Counter(
    "meraki_rate_limited_total",
    "Count of HTTP 429 rate-limit responses from the Meraki API",
    ["org_id"],
)
collection_duration = Histogram(
    "meraki_collection_duration_seconds",
    "Wall time of one full collection cycle",
    ["org_id"],
    buckets=(1, 2, 5, 10, 20, 30, 60, 120),
)
last_success = Gauge(
    "meraki_last_successful_collection_timestamp_seconds",
    "Unix timestamp of the last fully successful collection cycle",
    ["org_id"],
)
uplinks_discovered = Gauge(
    "meraki_uplinks_discovered",
    "Number of uplinks seen in the most recent collection cycle",
    ["org_id"],
)
exporter_up = Gauge(
    "meraki_exporter_up",
    "1 if the exporter's collection thread is running",
)

# ----------------------------------------------------------------------------
# Capacity mapping
# ----------------------------------------------------------------------------


def load_capacity(path: str) -> Dict[str, Dict[str, Any]]:
    """Load static serial+uplink -> circuit metadata mapping.

    Meraki does not expose contracted circuit bandwidth. Utilisation percentage
    is meaningless without it, so it comes from this file (later, from the CMDB).
    """
    if not os.path.exists(path):
        log.warning("capacity file %s not found; no utilisation will be calculable", path)
        return {}
    try:
        with open(path, "r", encoding="utf-8") as fh:
            raw = yaml.safe_load(fh) or {}
        entries = raw.get("circuits", [])
        mapping = {}
        for e in entries:
            key = f"{e['serial']}|{e['uplink']}"
            mapping[key] = e
        log.info("loaded %d circuit capacity entries from %s", len(mapping), path)
        return mapping
    except Exception:
        log.exception("failed to load capacity file %s", path)
        return {}


def publish_capacity(mapping: Dict[str, Dict[str, Any]]) -> None:
    capacity_bps.clear()
    for entry in mapping.values():
        bps = entry.get("capacity_bps")
        if not bps:
            continue
        # Normalise the capacity file's site_id through the same two-token
        # rule as hostnames, so WAN metrics and device metrics agree on what
        # a site is. Without this the two halves never join on a dashboard.
        raw_site = str(entry.get("site_id", "") or "")
        site_id = site_id_from_hostname(raw_site) or raw_site.upper() or "unknown"
        country, region, priority = (
            resolve_site(site_id) if site_id != "unknown"
            else ("unknown", "unknown", "P4"))
        capacity_bps.labels(
            serial=entry["serial"],
            uplink=entry["uplink"],
            circuit_id=entry.get("circuit_id", "unknown"),
            provider=entry.get("provider", "unknown"),
            site_id=site_id,
            region=region, country=country, priority=priority,
        ).set(float(bps))


# ----------------------------------------------------------------------------
# Meraki API helpers
# ----------------------------------------------------------------------------

# ---------------------------------------------------------------------------
# Hostname -> site parsing
# ---------------------------------------------------------------------------

_sites = {}
_prefix_country = {}
_country_region = {}


def load_sites(path):
    """Load the authoritative site -> country/region/priority lookup."""
    global _sites, _prefix_country, _country_region
    if not os.path.exists(path):
        log.warning("sites file %s not found; using ISO prefix fallback only", path)
        return
    try:
        with open(path, "r", encoding="utf-8") as fh:
            raw = json.load(fh)
        _sites = {k.upper(): v for k, v in (raw.get("sites") or {}).items()}
        _prefix_country = {k.upper(): v for k, v in (raw.get("prefix_country") or {}).items()}
        _country_region = raw.get("country_region") or {}
        log.info("loaded %d sites and %d prefixes from %s",
                 len(_sites), len(_prefix_country), path)
    except Exception:
        log.exception("failed to load %s", path)


def site_id_from_hostname(name):
    """First two dash-separated tokens, or None.

    AT-5789-ASD01 -> AT-5789. Requires a two-letter alphabetic prefix and a
    non-empty second token; anything else returns None so the caller can try
    the network-name fallback.
    """
    if not name:
        return None
    parts = str(name).strip().split("-")
    if len(parts) < 2:
        return None
    cc = parts[0].strip().upper()
    if len(cc) != 2 or not cc.isalpha():
        return None
    second = parts[1].strip().upper()
    if not second:
        return None
    return "%s-%s" % (cc, second)


def resolve_site(site_id):
    """site_id -> (country, region, priority).

    Precedence: exact match in sites.json, then the prefix mapping from the
    spreadsheet, then the built-in ISO table, then DEFAULT_REGION.
    """
    entry = _sites.get(site_id)
    if entry:
        return (entry.get("country", "unknown"),
                entry.get("region", DEFAULT_REGION),
                entry.get("priority", "P4"))
    cc = site_id.split("-")[0]
    country = _prefix_country.get(cc) or ISO_COUNTRY.get(cc, cc)
    region = _country_region.get(country) or CC_REGION.get(cc, DEFAULT_REGION)
    return country, region, "P4"


_ROLE_HINTS = (("ACCESS POINT", "AP"), ("FIREWALL", "FW"), ("SWITCH", "SW"),
               ("ROUTER", "RTR"), ("CAMERA", "CAM"), ("WIFI", "AP"),
               ("WLAN", "AP"))


def role_from_hostname(name):
    """Third token with trailing digits stripped, else a keyword guess."""
    parts = str(name or "").strip().split("-")
    # Walk tokens from the third onward; the first that is not purely numeric
    # is the role. Handles both AT-5789-ASD01 and IN-PN-001-SD01.
    for p in parts[2:]:
        tok = re.sub(r"\d+$", "", p).strip().upper()
        if tok:
            return tok
    up = (name or "").upper()
    for token, role in _ROLE_HINTS:
        if token in up:
            return role
    return "unknown"


def parse_device_name(name, org_id, network_name=""):
    """Returns (site_id, role, country, region, priority)."""
    name = (name or "").strip()
    site_id = site_id_from_hostname(name)

    if site_id is None and NETWORK_FALLBACK:
        site_id = site_id_from_hostname(network_name)
        if site_id is not None:
            device_name_via_network.labels(org_id=org_id).inc()

    if site_id is None:
        device_name_unparsed.labels(org_id=org_id).inc()
        return "unknown", "unknown", "unknown", "unknown", "P4"

    country, region, priority = resolve_site(site_id)
    return site_id, role_from_hostname(name), country, region, priority


DEVICE_STATUS_VALUE = {
    "online": 1.0,
    "alerting": 0.5,
    "dormant": 0.0,
    "offline": 0.0,
}


STATUS_VALUE = {
    "active": 1.0,
    "ready": 0.5,
    "connecting": 0.0,
    "not connected": 0.0,
    "failed": 0.0,
}


def call(dashboard: meraki.DashboardAPI, org_id: str, endpoint: str, fn, **kwargs):
    """Invoke a Meraki SDK call with timing, counting and error classification."""
    start = time.monotonic()
    try:
        result = fn(**kwargs)
        api_duration.labels(org_id=org_id, endpoint=endpoint).observe(time.monotonic() - start)
        api_requests.labels(org_id=org_id, endpoint=endpoint, outcome="success").inc()
        return result
    except meraki.APIError as exc:
        api_duration.labels(org_id=org_id, endpoint=endpoint).observe(time.monotonic() - start)
        status = getattr(exc, "status", None)
        if status == 429:
            rate_limited.labels(org_id=org_id).inc()
            api_requests.labels(org_id=org_id, endpoint=endpoint, outcome="rate_limited").inc()
            log.warning("[%s] %s rate limited (429)", org_id, endpoint)
        elif status == 404:
            # Meraki returns 404 rather than 403 for a bad API key, to avoid
            # revealing whether a resource exists. Sustained 404s = bad key.
            api_requests.labels(org_id=org_id, endpoint=endpoint, outcome="not_found").inc()
            log.error("[%s] %s returned 404 -- check API key validity and org ID", org_id, endpoint)
        else:
            api_requests.labels(org_id=org_id, endpoint=endpoint, outcome="error").inc()
            log.error("[%s] %s failed: %s", org_id, endpoint, exc)
        return None
    except Exception as exc:
        api_duration.labels(org_id=org_id, endpoint=endpoint).observe(time.monotonic() - start)
        api_requests.labels(org_id=org_id, endpoint=endpoint, outcome="error").inc()
        log.error("[%s] %s unexpected failure: %s", org_id, endpoint, exc)
        return None


def latest_timeseries_point(series: List[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    """Return the most recent entry that actually carries a measurement."""
    for point in reversed(series or []):
        if point.get("lossPercent") is not None or point.get("latencyMs") is not None:
            return point
    return None


# ----------------------------------------------------------------------------
# Collection cycle
# ----------------------------------------------------------------------------


def collect_org(
    dashboard: meraki.DashboardAPI,
    org_id: str,
    org_name: str,
    capacity: Dict[str, Dict[str, Any]],
) -> None:
    cycle_start = time.monotonic()
    network_names: Dict[str, str] = {}
    seen = 0

    # --- 1. Throughput --------------------------------------------------
    usage = call(
        dashboard,
        org_id,
        "getOrganizationApplianceUplinksUsageByNetwork",
        dashboard.appliance.getOrganizationApplianceUplinksUsageByNetwork,
        organizationId=org_id,
        timespan=TIMESPAN,
    )

    if usage:
        for network in usage:
            net_id = network.get("networkId", "unknown")
            net_name = network.get("name", net_id)
            network_names[net_id] = net_name

            for link in network.get("byUplink", []):
                serial = link.get("serial", "unknown")
                iface = link.get("interface", "unknown")
                labels = dict(
                    org=org_name,
                    org_id=org_id,
                    network=net_name,
                    network_id=net_id,
                    serial=serial,
                    uplink=iface,
                )
                # The endpoint returns total bytes over the timespan, so divide
                # to obtain a rate. This is an average over TIMESPAN seconds --
                # it will not show microbursts. That is a hard property of the
                # Meraki data, not a limitation of this exporter.
                sent_bps.labels(**labels).set((link.get("sent") or 0) / TIMESPAN)
                recv_bps.labels(**labels).set((link.get("received") or 0) / TIMESPAN)
                seen += 1

    # --- 2. Up/down status ----------------------------------------------
    statuses = call(
        dashboard,
        org_id,
        "getOrganizationApplianceUplinkStatuses",
        dashboard.appliance.getOrganizationApplianceUplinkStatuses,
        organizationId=org_id,
        total_pages="all",
    )

    if statuses:
        for device in statuses:
            net_id = device.get("networkId", "unknown")
            serial = device.get("serial", "unknown")
            net_name = network_names.get(net_id, net_id)

            for link in device.get("uplinks", []):
                iface = link.get("interface", "unknown")
                state = (link.get("status") or "unknown").lower()
                labels = dict(
                    org=org_name,
                    org_id=org_id,
                    network=net_name,
                    network_id=net_id,
                    serial=serial,
                    uplink=iface,
                )
                uplink_status.labels(**labels).set(STATUS_VALUE.get(state, 0.0))
                uplink_status_info.labels(status=state, **labels).set(1.0)

    # --- 3. Loss and latency --------------------------------------------
    quality = call(
        dashboard,
        org_id,
        "getOrganizationDevicesUplinksLossAndLatency",
        dashboard.organizations.getOrganizationDevicesUplinksLossAndLatency,
        organizationId=org_id,
        timespan=TIMESPAN,
    )

    if quality:
        for record in quality:
            net_id = record.get("networkId", "unknown")
            serial = record.get("serial", "unknown")
            iface = record.get("uplink", "unknown")
            net_name = network_names.get(net_id, net_id)

            point = latest_timeseries_point(record.get("timeSeries", []))
            if not point:
                continue

            labels = dict(
                org=org_name,
                org_id=org_id,
                network=net_name,
                network_id=net_id,
                serial=serial,
                uplink=iface,
            )
            if point.get("lossPercent") is not None:
                loss_percent.labels(**labels).set(float(point["lossPercent"]))
            if point.get("latencyMs") is not None:
                latency_ms.labels(**labels).set(float(point["latencyMs"]))

    # --- 4. Bookkeeping --------------------------------------------------
    uplinks_discovered.labels(org_id=org_id).set(seen)
    collection_duration.labels(org_id=org_id).observe(time.monotonic() - cycle_start)

    if usage is not None and statuses is not None:
        last_success.labels(org_id=org_id).set(time.time())
        log.info(
            "[%s] cycle complete: %d uplinks in %.1fs",
            org_name,
            seen,
            time.monotonic() - cycle_start,
        )
    else:
        log.warning("[%s] cycle incomplete -- some endpoints returned no data", org_name)


def extract_items(payload):
    """Newer Meraki endpoints wrap results in {"items": [...]}, older ones
    return a bare list. Handle both so callers do not have to care."""
    if not payload:
        return []
    if isinstance(payload, dict):
        return payload.get("items") or payload.get("data") or []
    if isinstance(payload, list):
        return payload
    return []


def fetch_networks(dashboard, org_id):
    """networkId -> name. The availabilities endpoint returns only the id."""
    nets = call(dashboard, org_id, "getOrganizationNetworks",
                dashboard.organizations.getOrganizationNetworks,
                organizationId=org_id, total_pages="all")
    out = {}
    for n in nets or []:
        out[n.get("id")] = n.get("name", n.get("id"))
    return out


def collect_org_devices(dashboard, org_id, org_name, networks):
    """Collect device availability, memory and (access points only) CPU load.

    All three endpoints are ORGANISATION-WIDE: one call covers every device,
    so call count does not grow with fleet size.
    """
    cycle_start = time.monotonic()
    meta = {}
    site_total = {}
    site_online = {}
    site_meta = {}
    role_count = {}

    # --- availability, all product types ---------------------------------
    # getOrganizationDevicesStatuses is deprecated; availabilities replaces it.
    avail = call(
        dashboard, org_id, "getOrganizationDevicesAvailabilities",
        dashboard.organizations.getOrganizationDevicesAvailabilities,
        organizationId=org_id, total_pages="all",
    )
    if not avail:
        log.warning("[%s] no device availability data returned", org_name)
        return {}

    for dev in extract_items(avail):
        serial = dev.get("serial", "unknown")
        name = dev.get("name") or serial
        net = dev.get("network") or {}
        net_id = net.get("id", "unknown")
        site_id, role, country, region, priority = parse_device_name(
            name, org_id, networks.get(net_id, ""))

        labels = dict(
            org=org_name, org_id=org_id, region=region, country=country,
            site_id=site_id, priority=priority,
            network=networks.get(net_id, net_id), network_id=net_id,
            device_name=name, serial=serial,
            model=dev.get("model", "unknown"),
            product_type=dev.get("productType", "unknown"),
            device_role=role,
        )
        site_meta[site_id] = (region, country, priority)
        role_key = (site_id, role, dev.get("productType", "unknown"))
        role_count[role_key] = role_count.get(role_key, 0) + 1
        meta[serial] = labels

        status = (dev.get("status") or "unknown").lower()
        value = DEVICE_STATUS_VALUE.get(status, 0.0)
        device_up.labels(**labels).set(value)
        device_status_info.labels(status=status, **labels).set(1.0)

        site_total[site_id] = site_total.get(site_id, 0) + 1
        if value == 1.0:
            site_online[site_id] = site_online.get(site_id, 0) + 1

    for site_id, total in site_total.items():
        region, country, priority = site_meta.get(
            site_id, (DEFAULT_REGION, "unknown", "P4"))
        sl = dict(org=org_name, org_id=org_id, region=region, country=country,
                  site_id=site_id, priority=priority)
        site_devices_total.labels(**sl).set(total)
        site_devices_online.labels(**sl).set(site_online.get(site_id, 0))

    for (site_id, role, ptype), n in role_count.items():
        region, country, priority = site_meta.get(
            site_id, (DEFAULT_REGION, "unknown", "P4"))
        site_devices_by_role.labels(
            org=org_name, org_id=org_id, region=region, country=country,
            site_id=site_id, priority=priority,
            device_role=role, product_type=ptype).set(n)

    # --- memory, all product types ---------------------------------------
    mem = call(
        dashboard, org_id,
        "getOrganizationDevicesSystemMemoryUsageHistoryByInterval",
        dashboard.organizations.getOrganizationDevicesSystemMemoryUsageHistoryByInterval,
        organizationId=org_id, timespan=MEMORY_TIMESPAN,
        interval=MEMORY_INTERVAL, total_pages="all",
    )
    for rec in extract_items(mem):
        labels = meta.get(rec.get("serial"))
        if not labels:
            continue
        # The API reports kilobytes; convert so the metric name stays honest.
        used_kb = (rec.get("used") or {}).get("median")
        free_kb = (rec.get("free") or {}).get("median")
        if used_kb is not None:
            device_memory_used_bytes.labels(**labels).set(float(used_kb) * 1024)
        if free_kb is not None:
            device_memory_free_bytes.labels(**labels).set(float(free_kb) * 1024)

        pct = None
        for iv in reversed(rec.get("intervals") or []):
            p = (((iv.get("memory") or {}).get("used") or {})
                 .get("percentages") or {}).get("maximum")
            if p is not None:
                pct = p
                break
        if pct is None and used_kb and free_kb:
            total_kb = float(used_kb) + float(free_kb)
            pct = 100.0 * float(used_kb) / total_kb if total_kb else None
        if pct is not None:
            device_memory_used_percent.labels(**labels).set(float(pct))

    # --- CPU load: WIRELESS ACCESS POINTS ONLY ---------------------------
    # Meraki exposes no CPU metric whatsoever for MS switches or MX
    # appliances. This endpoint covers MR access points, and returns a load
    # average rather than a utilisation percentage.
    cpu = call(
        dashboard, org_id,
        "getOrganizationWirelessDevicesSystemCpuLoadHistory",
        dashboard.wireless.getOrganizationWirelessDevicesSystemCpuLoadHistory,
        organizationId=org_id, timespan=DEVICE_CYCLE * 2, total_pages="all",
    )
    for rec in extract_items(cpu):
        labels = meta.get(rec.get("serial"))
        if not labels:
            continue
        if rec.get("cpuCount"):
            device_cpu_count.labels(**labels).set(float(rec["cpuCount"]))
        for point in reversed(rec.get("series") or []):
            if point.get("cpuLoad5") is not None:
                device_cpu_load5.labels(**labels).set(float(point["cpuLoad5"]))
                break

    log.info("[%s] device cycle: %d devices, %d sites, %d countries in %.1fs",
             org_name, len(meta), len(site_total),
             len({c for _, c, _ in site_meta.values()}),
             time.monotonic() - cycle_start)
    return meta


def collect_org_switches(dashboard, org_id, org_name, meta):
    """Per-switch port aggregates.

    getOrganizationSwitchPortsStatusesBySwitch caps perPage at 20, so this is
    the most expensive sweep in the exporter -- roughly one request per 20
    switches. That cost is why it lives on the slow tier rather than being
    polled with everything else.

    We deliberately aggregate rather than emitting per-port series. Per-port
    across a large estate is six figures of cardinality for data that is
    almost never queried; "does this switch have ports in error" is the
    question that actually gets asked.
    """
    started = time.monotonic()
    pages = call(
        dashboard, org_id, "getOrganizationSwitchPortsStatusesBySwitch",
        dashboard.switch.getOrganizationSwitchPortsStatusesBySwitch,
        organizationId=org_id, total_pages="all", perPage=SWITCH_PER_PAGE,
    )
    count = 0
    for sw in extract_items(pages):
        labels = meta.get(sw.get("serial"))
        if not labels:
            continue
        sl = {k: labels[k] for k in ("org", "org_id", "region", "country",
                                     "site_id", "priority", "device_name",
                                     "serial", "model")}
        ports = sw.get("ports") or []
        connected = errors = warnings = clients = 0
        poe = 0.0
        for p in ports:
            if p.get("enabled") and p.get("status") == "Connected":
                connected += 1
            if p.get("errors"):
                errors += 1
            if p.get("warnings"):
                warnings += 1
            clients += int(p.get("clientCount") or 0)
            poe += float(p.get("powerUsageInWh") or 0)

        switch_ports_total.labels(**sl).set(len(ports))
        switch_ports_connected.labels(**sl).set(connected)
        switch_ports_errors.labels(**sl).set(errors)
        switch_ports_warnings.labels(**sl).set(warnings)
        switch_clients.labels(**sl).set(clients)
        switch_poe_watts.labels(**sl).set(poe)
        count += 1

    log.info("[%s] switch sweep: %d switches in %.1fs",
             org_name, count, time.monotonic() - started)


def collect_org_wireless(dashboard, org_id, org_name, meta):
    """Per-AP channel utilisation, split into WiFi and non-WiFi.

    The split matters operationally: high WiFi utilisation means you need more
    capacity, high non-WiFi utilisation means interference and more APs will
    not help.
    """
    started = time.monotonic()
    data = call(
        dashboard, org_id,
        "getOrganizationWirelessDevicesChannelUtilizationByDevice",
        dashboard.wireless.getOrganizationWirelessDevicesChannelUtilizationByDevice,
        organizationId=org_id, timespan=SLOW_CYCLE, total_pages="all",
    )
    count = 0
    for rec in extract_items(data):
        labels = meta.get(rec.get("serial"))
        if not labels:
            continue
        for band_rec in rec.get("byBand") or []:
            band = str(band_rec.get("band", "unknown"))
            wl = dict(labels, band=band)
            total = ((band_rec.get("total") or {}).get("percentage"))
            wifi = ((band_rec.get("wifi") or {}).get("percentage"))
            non = ((band_rec.get("nonWifi") or {}).get("percentage"))
            if total is not None:
                ap_channel_util.labels(**wl).set(float(total))
            if wifi is not None:
                ap_channel_util_wifi.labels(**wl).set(float(wifi))
            if non is not None:
                ap_channel_util_non_wifi.labels(**wl).set(float(non))
            count += 1

    log.info("[%s] wireless sweep: %d band readings in %.1fs",
             org_name, count, time.monotonic() - started)


def clear_slow_metrics():
    for metric in (switch_ports_total, switch_ports_connected, switch_ports_errors,
                   switch_ports_warnings, switch_poe_watts, switch_clients,
                   ap_channel_util, ap_channel_util_wifi, ap_channel_util_non_wifi):
        metric.clear()


def collect_org_capacity(dashboard, org_id, org_name, meta, file_capacity):
    """Discover uplink CIR from Meraki, falling back to capacity.yml.

    Meraki's traffic-shaping uplink bandwidth is what the appliance is
    configured to shape each WAN interface to, which in practice is set to the
    contracted circuit rate. It is not guaranteed to equal the CIR on the
    carrier's order form -- but it is maintained by the people who provision
    the circuits, it updates itself when a circuit is upgraded, and it beats a
    spreadsheet that goes stale the day it is written.

    Where Meraki has no limit configured, capacity.yml is used. Where neither
    knows, NO utilisation series is emitted for that circuit: an absence you
    can see and alert on is better than a plausible wrong number.

    The endpoint is per-network, hence the hourly cycle.
    """
    started = time.monotonic()
    networks = call(dashboard, org_id, "getOrganizationApplianceUplinkStatuses",
                    dashboard.appliance.getOrganizationApplianceUplinkStatuses,
                    organizationId=org_id, total_pages="all")
    if not networks:
        return

    # serial -> the uplinks that device actually has, so we only ask about
    # networks that really terminate WAN circuits.
    net_serials = {}
    for dev in extract_items(networks):
        nid = dev.get("networkId")
        if nid:
            net_serials.setdefault(nid, []).append(dev)

    from_meraki = from_file = unknown = 0
    by_region_missing = {}

    for net_id, devices in net_serials.items():
        bw = call(dashboard, org_id,
                  "getNetworkApplianceTrafficShapingUplinkBandwidth",
                  dashboard.appliance.getNetworkApplianceTrafficShapingUplinkBandwidth,
                  networkId=net_id)
        limits = (bw or {}).get("bandwidthLimits") or {}

        for dev in devices:
            serial = dev.get("serial", "unknown")
            labels = meta.get(serial)
            for link in dev.get("uplinks", []):
                iface = link.get("interface", "unknown")
                key = "%s|%s" % (serial, iface)

                if labels:
                    region = labels["region"]; country = labels["country"]
                    site_id = labels["site_id"]; priority = labels["priority"]
                else:
                    region = country = site_id = "unknown"; priority = "P4"

                bps = None
                source = "none"

                lim = limits.get(iface) or {}
                # Meraki reports Kbps. limitDown of 0 or null means unlimited,
                # which is not a usable denominator.
                down = lim.get("limitDown")
                up = lim.get("limitUp")
                if down:
                    bps = float(down) * 1000
                    source = "meraki"
                elif up:
                    bps = float(up) * 1000
                    source = "meraki"

                if bps is None:
                    entry = file_capacity.get(key)
                    if entry and entry.get("capacity_bps"):
                        bps = float(entry["capacity_bps"])
                        source = "file"

                if bps:
                    capacity_bps.labels(
                        serial=serial, uplink=iface,
                        circuit_id=(file_capacity.get(key, {}) or {}).get("circuit_id", "auto"),
                        provider=(file_capacity.get(key, {}) or {}).get("provider", "unknown"),
                        site_id=site_id, region=region, country=country,
                        priority=priority).set(bps)
                    if source == "meraki":
                        from_meraki += 1
                    else:
                        from_file += 1
                else:
                    unknown += 1
                    by_region_missing[region] = by_region_missing.get(region, 0) + 1

                capacity_source.labels(
                    org=org_name, org_id=org_id, region=region, country=country,
                    site_id=site_id, serial=serial, uplink=iface,
                    source=source).set(1)

    for region, n in by_region_missing.items():
        uplinks_without_capacity.labels(
            org=org_name, org_id=org_id, region=region).set(n)

    log.info("[%s] capacity sweep: %d from meraki, %d from file, %d unknown, in %.1fs",
             org_name, from_meraki, from_file, unknown, time.monotonic() - started)


def collect_org_inventory(dashboard, org_id, org_name, meta):
    """Full claimed-device inventory -- the discovery view.

    This is deliberately separate from health collection. It answers "what do
    we own and where is it" rather than "is it up", including devices claimed
    but not yet deployed, which never appear in availability data at all.
    """
    started = time.monotonic()
    inv = call(dashboard, org_id, "getOrganizationInventoryDevices",
               dashboard.organizations.getOrganizationInventoryDevices,
               organizationId=org_id, total_pages="all")
    if not inv:
        log.warning("[%s] no inventory returned", org_name)
        return

    by_model = {}
    by_fw = {}
    unassigned = {}
    totals = {}
    seen_sites = {}

    for dev in extract_items(inv):
        serial = dev.get("serial", "unknown")
        name = dev.get("name") or serial
        ptype = dev.get("productType") or "unknown"
        model = dev.get("model") or "unknown"
        fw = dev.get("firmware") or "unknown"
        net_id = dev.get("networkId")

        known = meta.get(serial)
        if known:
            region, country = known["region"], known["country"]
            site_id, priority = known["site_id"], known["priority"]
            network, role = known["network"], known["device_role"]
        else:
            site_id, role, country, region, priority = parse_device_name(name, org_id)
            network = net_id or "unassigned"

        inventory_device.labels(
            org=org_name, org_id=org_id, region=region, country=country,
            site_id=site_id, priority=priority, network=network,
            device_name=name, serial=serial, model=model,
            product_type=ptype, firmware=fw, device_role=role,
        ).set(1.0 if net_id else 0.0)

        by_model[(region, ptype, model)] = by_model.get((region, ptype, model), 0) + 1
        by_fw[(ptype, fw)] = by_fw.get((ptype, fw), 0) + 1
        totals[ptype] = totals.get(ptype, 0) + 1
        if not net_id:
            unassigned[ptype] = unassigned.get(ptype, 0) + 1
        if site_id != "unknown":
            seen_sites[site_id] = (region, country, priority)

    for (region, ptype, model), n in by_model.items():
        inventory_by_model.labels(org=org_name, org_id=org_id, region=region,
                                  product_type=ptype, model=model).set(n)
    for (ptype, fw), n in by_fw.items():
        inventory_by_firmware.labels(org=org_name, org_id=org_id,
                                     product_type=ptype, firmware=fw).set(n)
    for ptype, n in totals.items():
        inventory_total.labels(org=org_name, org_id=org_id, product_type=ptype).set(n)
        inventory_unassigned.labels(org=org_name, org_id=org_id,
                                    product_type=ptype).set(unassigned.get(ptype, 0))
    for site_id, (region, country, priority) in seen_sites.items():
        site_priority_info.labels(org=org_name, org_id=org_id, region=region,
                                  country=country, site_id=site_id,
                                  priority=priority).set(1)

    log.info("[%s] inventory sweep: %d devices, %d models, %d unassigned, in %.1fs",
             org_name, sum(totals.values()), len(by_model),
             sum(unassigned.values()), time.monotonic() - started)


def clear_capacity_metrics():
    for m in (capacity_bps, capacity_source, uplinks_without_capacity):
        m.clear()


def clear_inventory_metrics():
    for m in (inventory_device, inventory_by_model, inventory_by_firmware,
              inventory_unassigned, inventory_total, site_priority_info):
        m.clear()


def clear_all_device_metrics():
    """Drop labelled children so decommissioned devices stop reporting."""
    for metric in (device_up, device_status_info, device_memory_used_bytes,
                   device_memory_free_bytes, device_memory_used_percent,
                   device_cpu_load5, device_cpu_count,
                   site_devices_total, site_devices_online, site_devices_by_role):
        metric.clear()


def clear_all_uplink_metrics() -> None:
    """Drop every labelled child so devices removed from Meraki stop reporting.

    Without this, a decommissioned appliance keeps exporting its last known
    value forever and appears permanently up.
    """
    for metric in (
        sent_bps,
        recv_bps,
        uplink_status,
        uplink_status_info,
        loss_percent,
        latency_ms,
    ):
        metric.clear()


def collection_loop(dashboard: meraki.DashboardAPI, orgs: List[Dict[str, str]], stop: threading.Event) -> None:
    load_sites(SITES_FILE)
    capacity = load_capacity(CAPACITY_FILE)
    capacity_reloaded_at = time.monotonic()

    # Device health changes far more slowly than throughput, and its endpoints
    # are heavier. Polling it on the same 60s clock would spend API budget for
    # no extra information, so it runs on its own longer cycle.
    devices_ran_at = 0.0
    slow_ran_at = 0.0
    capacity_ran_at = 0.0
    inventory_ran_at = 0.0
    networks_by_org = {}
    networks_at = 0.0
    meta_by_org = {}

    while not stop.is_set():
        started = time.monotonic()
        do_devices = (COLLECT_DEVICES
                      and (time.monotonic() - devices_ran_at) >= DEVICE_CYCLE)
        do_slow = (COLLECT_DEVICES
                   and (time.monotonic() - slow_ran_at) >= SLOW_CYCLE)
        do_capacity = (time.monotonic() - capacity_ran_at) >= CAPACITY_CYCLE
        do_inventory = (COLLECT_INVENTORY
                        and (time.monotonic() - inventory_ran_at) >= CAPACITY_CYCLE)

        if do_devices and (time.monotonic() - networks_at) > 900:
            for org in orgs:
                try:
                    networks_by_org[org["id"]] = fetch_networks(dashboard, org["id"])
                except Exception:
                    log.exception("[%s] network list refresh failed", org["name"])
            networks_at = time.monotonic()

        # Reload the capacity file hourly so circuit changes take effect
        # without restarting the exporter.
        if time.monotonic() - capacity_reloaded_at > 3600:
            capacity = load_capacity(CAPACITY_FILE)
            capacity_reloaded_at = time.monotonic()

        clear_all_uplink_metrics()
        if do_devices:
            clear_all_device_metrics()
        if do_slow:
            clear_slow_metrics()
        if do_capacity:
            clear_capacity_metrics()
        if do_inventory:
            clear_inventory_metrics()

        for org in orgs:
            if stop.is_set():
                break
            try:
                collect_org(dashboard, org["id"], org["name"], capacity)
            except Exception:
                log.exception("[%s] uplink cycle raised", org["name"])

            if do_devices:
                try:
                    meta_by_org[org["id"]] = collect_org_devices(
                        dashboard, org["id"], org["name"],
                        networks_by_org.get(org["id"], {})) or {}
                except Exception:
                    log.exception("[%s] device cycle raised", org["name"])

            # The slow tier reuses the label set built by the device sweep, so
            # it only runs on a cycle where devices were also collected.
            if do_slow and meta_by_org.get(org["id"]):
                meta = meta_by_org[org["id"]]
                if COLLECT_SWITCH:
                    try:
                        collect_org_switches(dashboard, org["id"], org["name"], meta)
                    except Exception:
                        log.exception("[%s] switch sweep raised", org["name"])
                if COLLECT_WIRELESS:
                    try:
                        collect_org_wireless(dashboard, org["id"], org["name"], meta)
                    except Exception:
                        log.exception("[%s] wireless sweep raised", org["name"])

            meta = meta_by_org.get(org["id"]) or {}
            if do_capacity and meta:
                try:
                    collect_org_capacity(dashboard, org["id"], org["name"],
                                         meta, capacity)
                except Exception:
                    log.exception("[%s] capacity sweep raised", org["name"])
            if do_inventory and meta:
                try:
                    collect_org_inventory(dashboard, org["id"], org["name"], meta)
                except Exception:
                    log.exception("[%s] inventory sweep raised", org["name"])

        if do_devices:
            devices_ran_at = time.monotonic()
        if do_slow:
            slow_ran_at = time.monotonic()
        if do_capacity:
            capacity_ran_at = time.monotonic()
        if do_inventory:
            inventory_ran_at = time.monotonic()

        elapsed = time.monotonic() - started
        sleep_for = max(5.0, POLL_INTERVAL - elapsed)
        if elapsed > POLL_INTERVAL:
            log.warning(
                "cycle took %.1fs, longer than the %ds poll interval", elapsed, POLL_INTERVAL
            )
        stop.wait(sleep_for)

    exporter_up.set(0)
    log.info("collection loop stopped")


# ----------------------------------------------------------------------------
# Entry point
# ----------------------------------------------------------------------------


def resolve_org_names(dashboard: meraki.DashboardAPI, org_ids: List[str]) -> List[Dict[str, str]]:
    orgs = []
    for org_id in org_ids:
        name = org_id
        try:
            info = dashboard.organizations.getOrganization(organizationId=org_id)
            name = info.get("name", org_id)
        except Exception as exc:
            log.warning("could not resolve name for org %s (%s); using the ID", org_id, exc)
        orgs.append({"id": org_id, "name": name})
        log.info("monitoring organisation %s (%s)", name, org_id)
    return orgs


def main() -> int:
    if not API_KEY:
        log.error("MERAKI_API_KEY is not set")
        return 1
    if not ORG_IDS:
        log.error("MERAKI_ORG_IDS is not set (comma-separated organisation IDs)")
        return 1

    log.info(
        "starting: poll=%ds timespan=%ds orgs=%d port=%d org_rate_limit=%d/s "
        "device_health=%s device_poll=%ds slow_poll=%ds switch=%s wireless=%s "
        "capacity_poll=%ds inventory=%s",
        POLL_INTERVAL, TIMESPAN, len(ORG_IDS), LISTEN_PORT, ORG_RATE_LIMIT,
        "on" if COLLECT_DEVICES else "off", DEVICE_CYCLE, SLOW_CYCLE,
        "on" if COLLECT_SWITCH else "off", "on" if COLLECT_WIRELESS else "off",
        CAPACITY_CYCLE, "on" if COLLECT_INVENTORY else "off",
    )

    dashboard = meraki.DashboardAPI(
        api_key=API_KEY,
        output_log=False,
        print_console=False,
        suppress_logging=True,
        # Honour Retry-After rather than hammering. Queued retries compound
        # the problem they are trying to solve.
        wait_on_rate_limit=True,
        maximum_retries=3,
        nginx_429_retry_wait_time=60,
        single_request_timeout=30,
        # SDK 4.x ships a token-bucket limiter that paces requests BEFORE they
        # are sent, rather than reacting to 429s after the fact. Meraki allows
        # 10 req/s per organisation; the SDK defaults to 9. We set it lower
        # still so that other integrations sharing this organisation's quota
        # are not starved by this exporter.
        smart_flow_enabled=True,
        smart_flow_org_rate=ORG_RATE_LIMIT,
        smart_flow_logging=False,
    )

    orgs = resolve_org_names(dashboard, ORG_IDS)

    start_http_server(LISTEN_PORT)
    exporter_up.set(1)
    log.info("metrics available on :%d/metrics", LISTEN_PORT)

    stop = threading.Event()

    def handle_signal(signum, _frame):
        log.info("received signal %s, shutting down", signum)
        stop.set()

    signal.signal(signal.SIGTERM, handle_signal)
    signal.signal(signal.SIGINT, handle_signal)

    worker = threading.Thread(
        target=collection_loop, args=(dashboard, orgs, stop), name="collector", daemon=True
    )
    worker.start()

    while worker.is_alive():
        worker.join(timeout=1.0)

    return 0


if __name__ == "__main__":
    sys.exit(main())
