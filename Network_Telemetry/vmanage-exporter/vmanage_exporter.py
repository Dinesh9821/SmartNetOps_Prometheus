#!/usr/bin/env python3
"""
Cisco Catalyst SD-WAN (Viptela) exporter for Prometheus.

Collects from vManage on a background thread and caches the results; /metrics
serves the cache. Same discipline as the Meraki exporter -- scraping never
triggers an API call, so adding a second Prometheus does not double the load
on your SD-WAN control plane.

WHY THE BULK ENDPOINTS ONLY
  vManage exposes "real-time" endpoints that take ?deviceId= and traverse the
  control plane to the router. Polling those across a fleet will destabilise
  vManage, which is a controller, not a monitoring appliance. Everything here
  uses /dataservice/data/device/state/... which is fabric-wide: one call
  covers every device.

SESSION HYGIENE
  vManage caps concurrent sessions at 100 and evicts the least recently used
  when full. A collector that logs in per cycle will evict real users. This
  opens ONE session, reuses it, re-authenticates only on 302/HTML, and logs
  out on shutdown.

SITE AND ROLE
  site_id is the first two dash-separated tokens of the hostname:
      AT-5678-ASD01 -> AT-5678
  A hostname containing "SD" is a router. Region, country and priority come
  from the same sites.json the Meraki exporter uses, so both estates land on
  the same dashboards with the same labels.

--------------------------------------------------------------------------
CHANGES IN THIS VERSION (v2) -- read this before diffing
--------------------------------------------------------------------------

1. WAN LINK DISCOVERY IS NO LONGER A SIDE EFFECT OF vpn_id == "0".

   The previous version fetched interfaces with first_working(), which stops
   at the FIRST candidate entity that returns any rows. On a mixed fabric
   /dataservice/data/device/state/Interface answers for vEdge devices, so
   InterfaceCEdge was never queried and every IOS-XE SD-WAN router silently
   had zero interfaces -- hence "every device has a WAN link but the
   dashboard shows none". Interfaces are now fetched from ALL candidate
   entities and merged, deduplicated on (device, ifname, vpn_id).

2. vpn_id NORMALISATION. dict.get(key, default) only returns the default when
   the key is ABSENT. vManage returns "vpn-id": null on several cEdge state
   entities, so str(None) produced vpn_id="None", and the recording rule
   filter {vpn_id="0"} matched nothing. Values are now coalesced properly.

3. A DEDICATED WAN LINK FAMILY (vmanage_wan_link_*) that does not depend on
   the Prometheus recording-rule join to exist. WAN membership is decided by
   a four-stage chain, best evidence first:
        override  -> /config/wan_links.json says so
        tloc      -> the interface carries a TLOC (ControlLocalProperty)
        vpn0      -> transport VPN, minus management/tunnel/system names
        heuristic -> ifname matches WAN_IFNAME_REGEX
   Which stage matched is published per link, so a blank panel is always
   traceable to a stage rather than to a guess.

4. UTILISATION IS COMPUTED IN THE EXPORTER, not only in a recording rule,
   because the join in unified-rules.yml silently drops links whose capacity
   series is missing. Denominator precedence: wan_links.json CIR, then
   configured bandwidth (optional), then negotiated port speed. The basis is
   labelled so a panel never implies a CIR it does not have.

5. OSPF, EIGRP AND THE ROUTE TABLE are collected. EIGRP has no bulk state
   entity on most vManage builds; rather than fake it, the exporter publishes
   vmanage_protocol_data_available{protocol="eigrp"} 0 so the dashboard can
   state "Data not available from current collector" truthfully.

6. PARTIAL-FAILURE HANDLING. clear_all() used to wipe every metric at the top
   of each cycle, so one failed endpoint blanked working panels for a whole
   interval. Each family is now cleared only when its own fetch succeeded.

7. /routes and /healthz are served alongside /metrics. Per-prefix route data
   is far too high-cardinality for Prometheus at 7,000 devices, so prefixes
   are served as JSON on demand and only counts go into the TSDB.
"""

import http.cookiejar
import json
import logging
import os
import re
import signal
import ssl
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from prometheus_client import (CONTENT_TYPE_LATEST, REGISTRY, Counter, Gauge,
                               Histogram, generate_latest)

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

VMANAGE_HOST = os.environ.get("VMANAGE_HOST", "").strip()
VMANAGE_PORT = int(os.environ.get("VMANAGE_PORT", "443"))
VMANAGE_USER = os.environ.get("VMANAGE_USER", "").strip()
VMANAGE_PASS = os.environ.get("VMANAGE_PASS", "")
VERIFY_TLS = os.environ.get("VMANAGE_VERIFY_TLS", "false").lower() == "true"
CA_BUNDLE = os.environ.get("VMANAGE_CA_BUNDLE", "").strip()

LISTEN_PORT = int(os.environ.get("EXPORTER_PORT", "9823"))
POLL_INTERVAL = int(os.environ.get("POLL_INTERVAL_SECONDS", "60"))
INVENTORY_CYCLE = int(os.environ.get("INVENTORY_POLL_INTERVAL_SECONDS", "900"))
REQUEST_TIMEOUT = int(os.environ.get("REQUEST_TIMEOUT_SECONDS", "60"))
PAGE_SIZE = int(os.environ.get("PAGE_SIZE", "2000"))
SITES_FILE = os.environ.get("SITES_FILE", "/config/sites.json")
# Optional. Circuit provider, circuit ID, contracted CIR and primary/secondary
# role per WAN link. vManage has none of this -- it is commercial data.
WAN_LINKS_FILE = os.environ.get("WAN_LINKS_FILE", "/config/wan_links.json")
# Pace requests. vManage has no published rate limit, but it is a control
# plane -- back-to-back heavy queries do affect it.
REQUEST_GAP = float(os.environ.get("REQUEST_GAP_SECONDS", "0.4"))
LOG_LEVEL = os.environ.get("LOG_LEVEL", "INFO").upper()

# Routers are identified by "SD" appearing in the hostname.
ROUTER_TOKEN = os.environ.get("ROUTER_HOSTNAME_TOKEN", "SD").upper()
DEFAULT_REGION = os.environ.get("DEFAULT_REGION", "EMEA")

# --- WAN discovery tuning --------------------------------------------------
# Interfaces in VPN 0 that are NOT circuits: the system interface, the OOB
# management port, null, and the SD-WAN tunnel overlays which ride on the
# physical and would double-count its traffic.
WAN_EXCLUDE_REGEX = re.compile(
    os.environ.get("WAN_EXCLUDE_REGEX",
                   r"^(system|eth0|mgmt\d*|Null\d*|Tunnel\d+|Sdwan-system-intf)$"),
    re.IGNORECASE)
# Last-resort name match, used only when nothing above identified any link.
WAN_IFNAME_REGEX = re.compile(
    os.environ.get("WAN_IFNAME_REGEX",
                   r"^(GigabitEthernet|TenGigabitEthernet|TwentyFiveGigE|"
                   r"FortyGigabitEthernet|HundredGigE|Cellular|Dialer|ATM|"
                   r"Serial|ge\d|ipsec|pppoe)"),
    re.IGNORECASE)
# Treat configured bandwidth-upstream/downstream as the CIR. Off by default:
# the unit differs between releases and a wrong unit produces a utilisation
# figure that is confidently wrong, which is worse than a blank panel.
USE_CONFIGURED_BANDWIDTH = os.environ.get(
    "USE_CONFIGURED_BANDWIDTH", "false").lower() == "true"
BANDWIDTH_FIELD_UNIT = os.environ.get("BANDWIDTH_FIELD_UNIT", "kbps").lower()

# --- scale controls --------------------------------------------------------
# Per-session BFD detail is the single biggest series producer on a large
# fabric (devices x tunnels). "all" preserves existing dashboards; "down_only"
# keeps aggregates for everything and detail only for sessions that are down.
BFD_SESSION_DETAIL = os.environ.get("BFD_SESSION_DETAIL", "all").lower()
# Per-interface detail for service-VPN (LAN) interfaces. WAN links are always
# exported regardless of this setting.
EXPORT_LAN_INTERFACES = os.environ.get(
    "EXPORT_LAN_INTERFACES", "true").lower() == "true"
ENABLE_ROUTES = os.environ.get("ENABLE_ROUTES", "true").lower() == "true"
ROUTE_CACHE_MAX_PER_DEVICE = int(
    os.environ.get("ROUTE_CACHE_MAX_PER_DEVICE", "5000"))

# --- statistics API --------------------------------------------------------
#
# Interface THROUGHPUT is not in the state database. State carries config and
# status -- admin/oper, speed, IP -- and nothing else. Rates live in a
# separate statistics store with different endpoints AND a different field
# naming convention: statistics use underscores (rx_kbps, vdevice_name) where
# state uses hyphens (rx-kbps, vdevice-name). Code written for one silently
# reads nothing from the other.
#
# Endpoint spelling matters more than it should. On a 20.x controller:
#   /dataservice/statistics/interface?query={...}          -> works
#   /dataservice/data/device/statistics/interfacestatistics -> "Invalid Query
#                                                              Param query"
# Both appear in Cisco's documentation. Only the first accepts a query here,
# so it is first in the list and the other is kept purely as a fallback for
# builds that behave the other way round.
STATS_ENABLED = os.environ.get("STATS_ENABLED", "true").lower() == "true"

# vManage batches statistics on a cycle of its own -- entry_time and
# statcycletime in the response are minutes apart. Polling faster than the
# controller aggregates produces identical answers at real cost to a box that
# is a control plane first and a telemetry store second. Five minutes is
# comfortably inside the sampling cadence.
STATS_POLL_INTERVAL = int(os.environ.get("STATS_POLL_INTERVAL_SECONDS", "300"))

# Look-back window for the query. One hour is wide enough to survive a missed
# collection cycle and narrow enough to keep the result set small.
STATS_WINDOW_HOURS = int(os.environ.get("STATS_WINDOW_HOURS", "1"))

# The statistics API caps a result set at 10,000 rows. That is a HARD ceiling,
# not a page size -- there is no continuation token, the rest is simply not
# returned. A 723-device fabric at ~24 interfaces sampled several times an
# hour is well over 100,000 rows, so a single fleet-wide query silently
# returns a arbitrary tenth of the estate.
#
# So devices are queried in batches sized to stay under the ceiling, and the
# exporter checks whether any batch came back exactly at the cap -- which is
# the signature of truncation and is surfaced as a metric rather than left to
# be discovered when a site mysteriously has no throughput.
STATS_ROW_CAP = int(os.environ.get("STATS_ROW_CAP", "10000"))
STATS_DEVICE_BATCH = int(os.environ.get("STATS_DEVICE_BATCH", "40"))

# Per-tunnel latency/jitter/loss. Same store, same caveats.
STATS_APPROUTE = os.environ.get("STATS_APPROUTE", "true").lower() == "true"

logging.basicConfig(
    level=getattr(logging, LOG_LEVEL, logging.INFO),
    format="%(asctime)s %(levelname)-7s %(name)s %(message)s",
)
log = logging.getLogger("vmanage-exporter")

CC_REGION = {
    "US": "AMER", "CA": "AMER", "MX": "AMER", "BR": "AMER", "AR": "AMER",
    "CL": "AMER", "CO": "AMER", "PE": "AMER", "VE": "AMER", "EC": "AMER",
    "UY": "AMER", "PY": "AMER", "BO": "AMER", "CR": "AMER", "PA": "AMER",
    "GT": "AMER", "DO": "AMER", "PR": "AMER", "HN": "AMER", "NI": "AMER",
    "AU": "APAC", "NZ": "APAC", "CN": "APAC", "HK": "APAC", "MO": "APAC",
    "TW": "APAC", "JP": "APAC", "KR": "APAC", "IN": "APAC", "SG": "APAC",
    "MY": "APAC", "TH": "APAC", "VN": "APAC", "PH": "APAC", "ID": "APAC",
    "BD": "APAC", "PK": "APAC", "LK": "APAC", "NP": "APAC", "MM": "APAC",
    "KH": "APAC", "LA": "APAC", "MN": "APAC", "BN": "APAC", "FJ": "APAC",
}

# ---------------------------------------------------------------------------
# Metrics
# ---------------------------------------------------------------------------

DEV_LABELS = ["region", "country", "site_id", "priority", "hostname",
              "system_ip", "device_type", "device_model", "device_role"]

device_reachable = Gauge(
    "vmanage_device_reachable",
    "1 reachable, 0.5 staging, 0 unreachable",
    DEV_LABELS,
)
device_state_info = Gauge(
    "vmanage_device_state_info",
    "1 per device, labelled with reachability and software version",
    DEV_LABELS + ["reachability", "version"],
)
device_uptime = Gauge(
    "vmanage_device_uptime_seconds", "Device uptime in seconds", DEV_LABELS,
)

# --- interfaces (all VPNs) -------------------------------------------------
# UNCHANGED NAMES AND LABELS. Existing dashboards and the unified recording
# rules query these, so they keep working exactly as before.
IF_LABELS = DEV_LABELS + ["ifname", "vpn_id", "color"]
if_oper_up = Gauge(
    "vmanage_interface_oper_up", "1 when the interface is operationally up", IF_LABELS,
)
if_admin_up = Gauge(
    "vmanage_interface_admin_up", "1 when the interface is administratively up", IF_LABELS,
)
if_rx_bps = Gauge(
    "vmanage_interface_rx_bits_per_second", "Receive rate", IF_LABELS,
)
if_tx_bps = Gauge(
    "vmanage_interface_tx_bits_per_second", "Transmit rate", IF_LABELS,
)
if_speed_bps = Gauge(
    "vmanage_interface_speed_bits_per_second",
    "Negotiated interface speed. This is PORT speed, not contracted CIR -- "
    "utilisation computed against it will understate congestion on a circuit "
    "whose CIR is lower than the port.",
    IF_LABELS,
)
if_rx_errors = Gauge(
    "vmanage_interface_rx_errors", "Receive errors since counter reset", IF_LABELS)
if_tx_errors = Gauge(
    "vmanage_interface_tx_errors", "Transmit errors since counter reset", IF_LABELS)
if_rx_drops = Gauge(
    "vmanage_interface_rx_drops", "Receive drops since counter reset", IF_LABELS)
if_tx_drops = Gauge(
    "vmanage_interface_tx_drops", "Transmit drops since counter reset", IF_LABELS)
if_rx_packets = Gauge(
    "vmanage_interface_rx_packets", "Received packets since counter reset", IF_LABELS)
if_tx_packets = Gauge(
    "vmanage_interface_tx_packets", "Transmitted packets since counter reset", IF_LABELS)

interfaces_seen = Gauge(
    "vmanage_interfaces_discovered",
    "Interface rows merged from all candidate entities on the last cycle. "
    "Zero here, with a non-zero device count, means the interface entity "
    "names in CANDIDATES do not match this vManage build.")

# --- WAN links -------------------------------------------------------------
# Numeric metrics carry only stable identity labels. Everything descriptive
# (provider, circuit, role, IP, how it was discovered) rides on the _info
# metric and is joined with group_left in Grafana, so a provider rename does
# not create a new time series for the throughput graph.
WAN_LABELS = DEV_LABELS + ["link", "color"]
wan_link_up = Gauge(
    "vmanage_wan_link_up",
    "1 when the WAN circuit is operationally up", WAN_LABELS)
wan_link_admin_up = Gauge(
    "vmanage_wan_link_admin_up",
    "1 when the WAN circuit is administratively up", WAN_LABELS)
wan_link_rx_bps = Gauge(
    "vmanage_wan_link_rx_bits_per_second", "WAN receive rate", WAN_LABELS)
wan_link_tx_bps = Gauge(
    "vmanage_wan_link_tx_bits_per_second", "WAN transmit rate", WAN_LABELS)
wan_link_capacity_bps = Gauge(
    "vmanage_wan_link_capacity_bits_per_second",
    "Denominator used for utilisation. basis=cir means a contracted rate from "
    "wan_links.json, basis=configured means the router's configured bandwidth, "
    "basis=port_speed means negotiated port speed and will understate "
    "congestion on a circuit slower than its port.",
    WAN_LABELS + ["basis"])
wan_link_utilization = Gauge(
    "vmanage_wan_link_utilization_percent",
    "100 * busiest direction / capacity. Absent when no capacity is known.",
    WAN_LABELS + ["basis"])
wan_link_rx_errors = Gauge(
    "vmanage_wan_link_rx_errors", "WAN receive errors", WAN_LABELS)
wan_link_tx_errors = Gauge(
    "vmanage_wan_link_tx_errors", "WAN transmit errors", WAN_LABELS)
wan_link_rx_drops = Gauge(
    "vmanage_wan_link_rx_drops", "WAN receive drops", WAN_LABELS)
wan_link_tx_drops = Gauge(
    "vmanage_wan_link_tx_drops", "WAN transmit drops", WAN_LABELS)
wan_link_info = Gauge(
    "vmanage_wan_link_info",
    "1 per WAN circuit, carrying its descriptive attributes. method records "
    "which discovery stage claimed the link: override, tloc, vpn0 or heuristic.",
    WAN_LABELS + ["provider", "circuit_id", "role", "transport", "ip",
                  "vpn_id", "method"])
wan_link_latency_ms = Gauge(
    "vmanage_wan_link_latency_ms",
    "Best BFD-reported latency across tunnels using this local colour. Only "
    "present when the BFD state entity carries latency on this build.",
    WAN_LABELS)
wan_link_jitter_ms = Gauge(
    "vmanage_wan_link_jitter_ms",
    "Best BFD-reported jitter across tunnels using this local colour", WAN_LABELS)
wan_link_loss_percent = Gauge(
    "vmanage_wan_link_loss_percent",
    "Best BFD-reported loss across tunnels using this local colour", WAN_LABELS)

wan_links_total = Gauge(
    "vmanage_wan_links_total", "WAN circuits on the device", DEV_LABELS)
wan_links_up = Gauge(
    "vmanage_wan_links_up", "WAN circuits operationally up on the device", DEV_LABELS)
site_wan_links_total = Gauge(
    "vmanage_site_wan_links_total", "WAN circuits at the site",
    ["region", "country", "site_id", "priority"])
site_wan_links_up = Gauge(
    "vmanage_site_wan_links_up", "WAN circuits up at the site",
    ["region", "country", "site_id", "priority"])
wan_discovery_method_count = Gauge(
    "vmanage_wan_discovery_method_count",
    "WAN circuits claimed by each discovery stage on the last cycle. If this "
    "is zero for every method the fabric has no discoverable circuits and the "
    "WAN panels will be empty -- start troubleshooting here.",
    ["method"])
wan_links_without_capacity = Gauge(
    "vmanage_wan_links_without_capacity",
    "WAN circuits carrying traffic with no usable denominator. This is a "
    "monitoring-coverage figure, not a fault.")

# --- OMP -------------------------------------------------------------------
omp_peer_up = Gauge(
    "vmanage_omp_peer_up", "1 when the OMP peer session is up",
    DEV_LABELS + ["peer", "peer_type", "domain_id"])
omp_peer_state_info = Gauge(
    "vmanage_omp_peer_state_info", "1 per OMP peer, labelled with its state",
    DEV_LABELS + ["peer", "peer_type", "state"])
omp_routes_received = Gauge(
    "vmanage_omp_routes_received", "OMP routes received from this peer",
    DEV_LABELS + ["peer"])
omp_routes_installed = Gauge(
    "vmanage_omp_routes_installed", "OMP routes installed from this peer",
    DEV_LABELS + ["peer"])
omp_routes_sent = Gauge(
    "vmanage_omp_routes_sent", "OMP routes advertised to this peer",
    DEV_LABELS + ["peer"])
omp_peers_total = Gauge(
    "vmanage_omp_peers_total", "OMP peers on the device", DEV_LABELS)
omp_peers_up = Gauge(
    "vmanage_omp_peers_up", "OMP peers in the up state", DEV_LABELS)

# --- BFD -------------------------------------------------------------------
BFD_LABELS = DEV_LABELS + ["remote_system_ip", "remote_site_id",
                           "local_color", "remote_color", "proto"]
bfd_session_up = Gauge(
    "vmanage_bfd_session_up", "1 when the BFD session is up", BFD_LABELS)
bfd_session_uptime = Gauge(
    "vmanage_bfd_session_uptime_seconds",
    "Seconds since the session last came up", BFD_LABELS)
bfd_session_latency_ms = Gauge(
    "vmanage_bfd_session_latency_ms",
    "Tunnel latency, where this vManage build reports it on the BFD entity",
    BFD_LABELS)
bfd_session_jitter_ms = Gauge(
    "vmanage_bfd_session_jitter_ms", "Tunnel jitter, where reported", BFD_LABELS)
bfd_session_loss_percent = Gauge(
    "vmanage_bfd_session_loss_percent", "Tunnel loss, where reported", BFD_LABELS)
bfd_sessions_total = Gauge(
    "vmanage_bfd_sessions_total", "BFD sessions on the device", DEV_LABELS)
bfd_sessions_up = Gauge(
    "vmanage_bfd_sessions_up", "BFD sessions up on the device", DEV_LABELS)

# --- BGP -------------------------------------------------------------------
bgp_neighbor_up = Gauge(
    "vmanage_bgp_neighbor_up",
    "1 when the neighbour is established. Anything else -- idle, connect, "
    "active, opensent -- is 0; a peer stuck in active is as down as one idle.",
    DEV_LABELS + ["peer_addr", "remote_as", "vpn_id"],
)
bgp_neighbor_state_info = Gauge(
    "vmanage_bgp_neighbor_state_info",
    "1 per neighbour, labelled with its FSM state",
    DEV_LABELS + ["peer_addr", "remote_as", "vpn_id", "state"],
)
bgp_prefixes_received = Gauge(
    "vmanage_bgp_prefixes_received",
    "Prefixes received from this neighbour",
    DEV_LABELS + ["peer_addr", "vpn_id"],
)
bgp_neighbors_total = Gauge(
    "vmanage_bgp_neighbors_total", "BGP neighbours on the device", DEV_LABELS,
)
bgp_neighbors_up = Gauge(
    "vmanage_bgp_neighbors_up", "BGP neighbours established", DEV_LABELS,
)

# --- OSPF ------------------------------------------------------------------
OSPF_LABELS = DEV_LABELS + ["neighbor_id", "area_id", "ifname", "vpn_id"]
ospf_neighbor_up = Gauge(
    "vmanage_ospf_neighbor_up",
    "1 when the adjacency is Full (or 2-Way on a broadcast segment where that "
    "is the correct terminal state for a DROTHER pair); 0 otherwise",
    OSPF_LABELS)
ospf_neighbor_state_info = Gauge(
    "vmanage_ospf_neighbor_state_info",
    "1 per adjacency, labelled with its state: full, 2-way, init, exstart, "
    "exchange, loading, down",
    OSPF_LABELS + ["state"])
ospf_neighbor_uptime = Gauge(
    "vmanage_ospf_neighbor_uptime_seconds",
    "Seconds the adjacency has been established, where reported", OSPF_LABELS)
ospf_dead_timer = Gauge(
    "vmanage_ospf_neighbor_dead_timer_seconds",
    "Seconds until the adjacency is declared dead, where reported", OSPF_LABELS)
ospf_neighbors_total = Gauge(
    "vmanage_ospf_neighbors_total", "OSPF adjacencies on the device", DEV_LABELS)
ospf_neighbors_up = Gauge(
    "vmanage_ospf_neighbors_up", "OSPF adjacencies in Full", DEV_LABELS)

# --- EIGRP -----------------------------------------------------------------
EIGRP_LABELS = DEV_LABELS + ["peer_addr", "as_number", "ifname", "vpn_id"]
eigrp_neighbor_up = Gauge(
    "vmanage_eigrp_neighbor_up", "1 when the EIGRP adjacency is up", EIGRP_LABELS)
eigrp_neighbor_uptime = Gauge(
    "vmanage_eigrp_neighbor_uptime_seconds",
    "Seconds the adjacency has been up, where reported", EIGRP_LABELS)
eigrp_neighbor_srtt_ms = Gauge(
    "vmanage_eigrp_neighbor_srtt_ms",
    "Smooth round-trip time to the peer, where reported", EIGRP_LABELS)
eigrp_neighbor_queue = Gauge(
    "vmanage_eigrp_neighbor_queue_count",
    "Packets queued to the peer. A persistently non-zero queue is the early "
    "symptom of a stuck-in-active condition.", EIGRP_LABELS)
eigrp_neighbors_total = Gauge(
    "vmanage_eigrp_neighbors_total", "EIGRP adjacencies on the device", DEV_LABELS)
eigrp_neighbors_up = Gauge(
    "vmanage_eigrp_neighbors_up", "EIGRP adjacencies up", DEV_LABELS)

# --- routing table ---------------------------------------------------------
routes_total = Gauge(
    "vmanage_routes_total", "Routes in the table by VPN and protocol",
    DEV_LABELS + ["vpn_id", "protocol"])
route_table_size = Gauge(
    "vmanage_route_table_size", "Total routes on the device", DEV_LABELS)
default_route_present = Gauge(
    "vmanage_default_route_present",
    "1 when 0.0.0.0/0 exists in the VPN. A branch whose transport VPN has lost "
    "its default route is broken even though every interface reads up.",
    DEV_LABELS + ["vpn_id"])

# --- data availability -----------------------------------------------------
protocol_available = Gauge(
    "vmanage_protocol_data_available",
    "1 when this vManage build returned usable data for the protocol on the "
    "last cycle, 0 when it did not. Dashboards should render "
    "'Data not available from current collector' on 0 rather than an empty "
    "panel, which is indistinguishable from 'everything is fine'.",
    ["protocol"])

control_connections_up = Gauge(
    "vmanage_control_connections_up",
    "Control connections in the up state", DEV_LABELS,
)
control_connection_state = Gauge(
    "vmanage_control_connection_up",
    "1 per control connection to a controller",
    DEV_LABELS + ["peer_type", "peer_system_ip", "local_color", "remote_color",
                  "protocol"])

# --- site rollups ---------------------------------------------------------
SITE_LABELS = ["region", "country", "site_id", "priority"]
site_devices_total = Gauge(
    "vmanage_site_devices_total", "SD-WAN devices at a site", SITE_LABELS)
site_devices_reachable = Gauge(
    "vmanage_site_devices_reachable", "SD-WAN devices reachable at a site", SITE_LABELS)
site_routers_total = Gauge(
    "vmanage_site_routers_total",
    "Devices at the site whose hostname marks them as routers", SITE_LABELS)

# --- exporter health ------------------------------------------------------
api_requests = Counter(
    "vmanage_api_requests_total", "vManage API requests issued",
    ["endpoint", "outcome"])
api_duration = Histogram(
    "vmanage_api_request_duration_seconds", "vManage API call duration",
    ["endpoint"], buckets=(0.5, 1, 2, 5, 10, 20, 30, 60, 120))
collection_duration = Histogram(
    "vmanage_collection_duration_seconds", "Full collection cycle duration",
    buckets=(1, 5, 10, 30, 60, 120, 300))
signal_duration = Gauge(
    "vmanage_signal_collection_duration_seconds",
    "Duration of the last collection for each signal", ["signal"])
last_success = Gauge(
    "vmanage_last_successful_collection_timestamp_seconds",
    "Unix timestamp of the last fully successful cycle")
endpoint_available = Gauge(
    "vmanage_endpoint_available",
    "1 if this endpoint returned usable data on the last attempt. Entity names "
    "differ between vManage versions, so the exporter probes candidates and "
    "records which one worked.",
    ["signal", "path"])
session_logins = Counter(
    "vmanage_session_logins_total",
    "Times the exporter has authenticated. A rising number means sessions are "
    "being invalidated -- vManage caps concurrent sessions at 100.")
stats_truncated = Gauge(
    "vmanage_stats_truncated_batches",
    "Statistics batches that came back exactly at the row cap. The API "
    "truncates without a continuation token, so a non-zero value here means "
    "throughput data is being silently discarded -- lower STATS_DEVICE_BATCH.")
stats_interfaces_seen = Gauge(
    "vmanage_stats_interfaces",
    "Interfaces with throughput from the statistics API on the last cycle")
stats_approute_seen = Gauge(
    "vmanage_stats_approute_paths",
    "Device/colour combinations with path quality on the last cycle")
stats_age_seconds = Gauge(
    "vmanage_stats_age_seconds",
    "Age of the newest statistics sample. vManage batches statistics on its "
    "own cycle, so a few minutes is normal; hours means collection has "
    "stopped on the controller and the throughput panels are showing stale "
    "numbers that still look live.")
wan_links_without_throughput = Gauge(
    "vmanage_wan_links_without_throughput",
    "WAN circuits known to exist but with no throughput sample. Coverage "
    "metric: it distinguishes an idle circuit from an unmonitored one, which "
    "look identical on a graph at zero.")

exporter_up = Gauge("vmanage_exporter_up", "1 while the collector thread runs")
exporter_build_info = Gauge(
    "vmanage_exporter_build_info", "1, labelled with the exporter version",
    ["version"])
hostname_unparsed = Counter(
    "vmanage_hostname_unparsed_total",
    "Hostnames with no recognisable site prefix")
rows_unmatched = Counter(
    "vmanage_rows_unmatched_total",
    "State rows whose device could not be matched to the device inventory. A "
    "high count here means the row's device key differs from /dataservice/device.",
    ["signal"])

# Bump this on every behavioural change. It is the only thing that makes a
# deployment verifiable from outside the box: after a restart,
# vmanage_exporter_build_info is the difference between "the new code is
# running" and "the copy silently failed and I restarted the old file".
# 3.0.0 -- WAN inventory from the TLOC table, throughput from the statistics
#          API, entity selection validated on field shape rather than row
#          count.
EXPORTER_VERSION = "3.0.0"
exporter_build_info.labels(version=EXPORTER_VERSION).set(1)

# ---------------------------------------------------------------------------
# Site resolution -- shared convention with the Meraki exporter
# ---------------------------------------------------------------------------

_sites, _prefix_country, _country_region = {}, {}, {}
# device -> ifname -> {provider, circuit_id, role, cir_down_mbps, cir_up_mbps}
_wan_overrides = {}
_wan_site_defaults = {}


def load_sites(path):
    global _sites, _prefix_country, _country_region
    if not os.path.exists(path):
        log.warning("sites file %s not found; using ISO prefix fallback", path)
        return
    try:
        raw = json.load(open(path, "r", encoding="utf-8"))
        _sites = {k.upper(): v for k, v in (raw.get("sites") or {}).items()}
        _prefix_country = {k.upper(): v for k, v in (raw.get("prefix_country") or {}).items()}
        _country_region = raw.get("country_region") or {}
        log.info("loaded %d sites and %d prefixes from %s",
                 len(_sites), len(_prefix_country), path)
    except Exception:
        log.exception("failed to load %s", path)


def load_wan_links(path):
    """Optional commercial metadata for WAN circuits.

    vManage knows a circuit's colour and port speed. It does not know who
    sells it, what the contract number is, what the committed rate is, or
    whether it is the primary. That information only exists in a procurement
    system, so it is supplied here as a file rather than invented.

    Structure:
      {
        "devices": {
          "AT-5678-ASD01": {
            "GigabitEthernet0/0/0": {
              "provider": "BT", "circuit_id": "BT-99231",
              "role": "primary", "cir_down_mbps": 100, "cir_up_mbps": 100
            }
          }
        },
        "sites": {
          "AT-5678": {"default_provider": "BT"}
        }
      }
    """
    global _wan_overrides, _wan_site_defaults
    if not os.path.exists(path):
        log.info("wan_links file %s not found; provider, circuit and CIR will "
                 "read 'unknown' and utilisation will fall back to port speed", path)
        return
    try:
        raw = json.load(open(path, "r", encoding="utf-8"))
        _wan_overrides = {
            dev: {ifn: attrs for ifn, attrs in (ifaces or {}).items()}
            for dev, ifaces in (raw.get("devices") or {}).items()
        }
        _wan_site_defaults = raw.get("sites") or {}
        n_links = sum(len(v) for v in _wan_overrides.values())
        log.info("loaded WAN metadata for %d links across %d devices from %s",
                 n_links, len(_wan_overrides), path)
    except Exception:
        log.exception("failed to load %s", path)


def site_id_from_hostname(name):
    """First two dash-separated tokens: AT-5678-ASD01 -> AT-5678."""
    if not name:
        return None
    parts = str(name).strip().split("-")
    if len(parts) < 2:
        return None
    cc = parts[0].strip().upper()
    if len(cc) != 2 or not cc.isalpha():
        return None
    second = parts[1].strip().upper()
    return "%s-%s" % (cc, second) if second else None


def resolve_site(site_id):
    entry = _sites.get(site_id)
    if entry:
        return (entry.get("country", "unknown"),
                entry.get("region", DEFAULT_REGION),
                entry.get("priority", "P4"))
    cc = site_id.split("-")[0]
    country = _prefix_country.get(cc, cc)
    region = _country_region.get(country) or CC_REGION.get(cc, DEFAULT_REGION)
    return country, region, "P4"


def device_role(hostname):
    """A hostname containing "SD" is a router; otherwise use the third token."""
    up = (hostname or "").upper()
    if ROUTER_TOKEN in up:
        return "ROUTER"
    parts = up.split("-")
    for p in parts[2:]:
        tok = "".join(c for c in p if c.isalpha())
        if tok:
            return tok
    return "unknown"


def device_labels(hostname, system_ip, dtype, model):
    site_id = site_id_from_hostname(hostname)
    if site_id is None:
        hostname_unparsed.inc()
        site_id, country, region, priority = "unknown", "unknown", "unknown", "P4"
    else:
        country, region, priority = resolve_site(site_id)
    return dict(region=region, country=country, site_id=site_id,
                priority=priority, hostname=hostname or "unknown",
                system_ip=system_ip or "unknown",
                device_type=dtype or "unknown",
                device_model=model or "unknown",
                device_role=device_role(hostname))


# ---------------------------------------------------------------------------
# vManage client
# ---------------------------------------------------------------------------


class NoRedirect(urllib.request.HTTPRedirectHandler):
    """vManage signals an invalidated session with a 302 to /welcome.html.
    Following it turns a clear auth failure into a confusing parse error."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class VManage(object):
    def __init__(self):
        self.base = "https://%s:%d" % (VMANAGE_HOST, VMANAGE_PORT)
        self.token = None
        self.lock = threading.Lock()

        ctx = ssl.create_default_context(cafile=CA_BUNDLE or None)
        if not VERIFY_TLS:
            # vManage is commonly self-signed. Set VMANAGE_VERIFY_TLS=true and
            # supply VMANAGE_CA_BUNDLE in production.
            ctx.check_hostname = False
            ctx.verify_mode = ssl.CERT_NONE
            log.warning("TLS verification disabled -- set VMANAGE_VERIFY_TLS=true "
                        "and VMANAGE_CA_BUNDLE for production")

        self.jar = http.cookiejar.CookieJar()
        self.opener = urllib.request.build_opener(
            urllib.request.HTTPCookieProcessor(self.jar),
            urllib.request.HTTPSHandler(context=ctx),
            NoRedirect(),
        )

    def _raw(self, path, data=None):
        url = self.base + path
        body = None
        hdrs = {"Accept": "application/json"}
        if data is not None:
            body = urllib.parse.urlencode(data).encode("utf-8")
            hdrs["Content-Type"] = "application/x-www-form-urlencoded"
        if self.token:
            hdrs["X-XSRF-TOKEN"] = self.token
        req = urllib.request.Request(url, data=body, headers=hdrs)
        try:
            resp = self.opener.open(req, timeout=REQUEST_TIMEOUT)
            return resp.getcode(), resp.read()
        except urllib.error.HTTPError as exc:
            return exc.code, exc.read()

    def login(self):
        """Two-step auth: JSESSIONID cookie, then XSRF token on 19.2+.

        On FAILED authentication vManage returns HTTP 200 with the HTML login
        page as the body. Checking only the status code sails past a bad
        password and fails confusingly later.
        """
        with self.lock:
            self.token = None
            self.jar.clear()
            status, body = self._raw("/j_security_check",
                                     data={"j_username": VMANAGE_USER,
                                           "j_password": VMANAGE_PASS})
            text = body.decode("utf-8", "replace").lstrip()
            if "<html" in text[:512].lower():
                raise RuntimeError("login rejected -- vManage returned the HTML "
                                   "login page; check credentials")
            if status not in (200, 302):
                raise RuntimeError("login failed with HTTP %s" % status)
            if not any(c.name == "JSESSIONID" for c in self.jar):
                raise RuntimeError("no JSESSIONID returned")

            st, tok = self._raw("/dataservice/client/token")
            if st == 200 and tok:
                cand = tok.decode("utf-8", "replace").strip()
                if "<html" not in cand.lower() and len(cand) < 4096:
                    self.token = cand
            session_logins.inc()
            log.info("authenticated to vManage (xsrf %s)",
                     "acquired" if self.token else "not required")

    def logout(self):
        try:
            self._raw("/logout?nocache=%d" % int(time.time()))
            log.info("logged out (session released)")
        except Exception:
            pass

    def get(self, endpoint, path, retry=True):
        """GET a dataservice path, re-authenticating once on session loss."""
        started = time.monotonic()
        try:
            status, body = self._raw(path)
        except Exception as exc:
            api_requests.labels(endpoint=endpoint, outcome="error").inc()
            log.error("%s failed: %s", endpoint, exc)
            return None
        api_duration.labels(endpoint=endpoint).observe(time.monotonic() - started)

        if status == 302:
            api_requests.labels(endpoint=endpoint, outcome="session_lost").inc()
            if retry:
                log.info("session lost on %s; re-authenticating", endpoint)
                try:
                    self.login()
                    return self.get(endpoint, path, retry=False)
                except Exception as exc:
                    log.error("re-authentication failed: %s", exc)
            return None

        if status == 403:
            api_requests.labels(endpoint=endpoint, outcome="forbidden").inc()
            log.error("%s forbidden -- the account lacks permission", endpoint)
            return None
        if status == 404:
            api_requests.labels(endpoint=endpoint, outcome="not_found").inc()
            return None
        if status != 200:
            api_requests.labels(endpoint=endpoint, outcome="http_%d" % status).inc()
            return None

        text = body.decode("utf-8", "replace")
        if text.lstrip().lower().startswith("<html"):
            api_requests.labels(endpoint=endpoint, outcome="auth_html").inc()
            if retry:
                try:
                    self.login()
                    return self.get(endpoint, path, retry=False)
                except Exception:
                    pass
            return None

        try:
            payload = json.loads(text)
        except ValueError:
            api_requests.labels(endpoint=endpoint, outcome="bad_json").inc()
            return None

        api_requests.labels(endpoint=endpoint, outcome="success").inc()
        time.sleep(REQUEST_GAP)
        return payload


def rows(payload):
    if not payload:
        return []
    if isinstance(payload, dict):
        return payload.get("data") or []
    return payload if isinstance(payload, list) else []


def first_working(vm, signal_name, candidates):
    """Entity names differ between vManage versions.

    Rather than assert one path, try each candidate and use whichever returns
    rows. The result is recorded as a metric so the working path is visible
    without reading logs.

    Use this for signals where exactly one entity holds the whole fabric --
    OMP, BFD, control connections. Do NOT use it for interfaces or routes,
    where vEdge and cEdge live in SEPARATE entities and stopping at the first
    hit silently drops half the estate. Use merge_all() for those.
    """
    for path in candidates:
        payload = vm.get(signal_name, path + "?count=%d" % PAGE_SIZE)
        data = rows(payload)
        if data:
            endpoint_available.labels(signal=signal_name, path=path).set(1)
            for other in candidates:
                if other != path:
                    endpoint_available.labels(signal=signal_name, path=other).set(0)
            return data, path
    for path in candidates:
        endpoint_available.labels(signal=signal_name, path=path).set(0)
    return [], None


def merge_all(vm, signal_name, candidates, key_fn):
    """Query EVERY candidate entity and merge the rows.

    THIS IS THE WAN LINK FIX. A fabric with both vEdge and IOS-XE SD-WAN
    routers splits its interface state across Interface, InterfaceVEdge and
    InterfaceCEdge. first_working() returns after the first entity that
    answers, so on a mixed fabric one platform's routers were exported with
    every interface and the other platform's routers with none. Because the
    first entity did answer, no error was logged and no availability metric
    went to zero -- the symptom was simply "the WAN link is missing for that
    device", which is exactly the reported bug.

    key_fn deduplicates rows that appear in more than one entity. First
    writer wins, and candidates are ordered most-specific-first so a
    platform-specific entity beats the generic one.
    """
    merged, seen, hits = [], set(), 0
    for path in candidates:
        payload = vm.get(signal_name, path + "?count=%d" % PAGE_SIZE)
        data = rows(payload)
        endpoint_available.labels(signal=signal_name, path=path).set(
            1 if data else 0)
        if not data:
            continue
        hits += 1
        for r in data:
            try:
                k = key_fn(r)
            except Exception:
                k = None
            if k is None:
                merged.append(r)
                continue
            if k in seen:
                continue
            seen.add(k)
            merged.append(r)
    if hits > 1:
        log.debug("%s: merged %d rows from %d entities", signal_name,
                  len(merged), hits)
    return merged


def stats_time_query(hours, extra_rules=None):
    """Build the query shape the statistics API expects.

    This is the payload the vManage GUI itself sends when it draws a
    statistics chart, which is why it is the right thing to imitate. Sending
    ?count=N instead -- correct for every state endpoint -- returns
    "Invalid Query Param query" from all of them, which reads exactly like
    "there is no data here" and is not.
    """
    rules = [{"value": [str(hours)], "field": "entry_time",
              "type": "date", "operator": "last_n_hours"}]
    if extra_rules:
        rules.extend(extra_rules)
    return {"query": {"condition": "AND", "rules": rules}}


def stats_fetch(vm, signal_name, path, body):
    """GET a statistics endpoint with a urlencoded query payload."""
    url = path + "?query=" + urllib.parse.quote(json.dumps(body))
    payload = vm.get(signal_name, url)
    return rows(payload)


def collect_interface_statistics(vm, hostnames):
    """(hostname, ifname) -> throughput, errors and configured bandwidth.

    Queried in device batches. The statistics API truncates any result set at
    STATS_ROW_CAP with no continuation token -- the remainder is simply not
    returned and nothing says so -- and a fleet-wide query blows through that
    ceiling many times over. Batching keeps each response comfortably inside
    it; a batch that comes back exactly AT the cap is reported through
    vmanage_stats_truncated_batches so the truncation is visible rather than
    discovered later as a site with no throughput.

    Only the most recent sample per (device, interface) is kept. The window
    holds several samples and the newest is the only one that describes now.
    """
    out = {}
    if not STATS_ENABLED or not hostnames:
        return out

    ordered = sorted(hostnames)
    batches = [ordered[i:i + STATS_DEVICE_BATCH]
               for i in range(0, len(ordered), STATS_DEVICE_BATCH)]
    truncated = 0
    latest = {}

    for batch in batches:
        body = stats_time_query(
            STATS_WINDOW_HOURS,
            [{"value": batch, "field": "host_name",
              "type": "string", "operator": "in"}])
        data = stats_fetch(vm, "stats_interface",
                           "/dataservice/statistics/interface", body)
        if len(data) >= STATS_ROW_CAP:
            truncated += 1
        for r in data:
            host = pick(r, "host_name", "vdevice_name")
            ifname = pick(r, "interface")
            if not host or not ifname:
                continue
            key = (as_str(host), as_str(ifname))
            ts = fnum(pick(r, "entry_time"), 0.0) or 0.0
            if key in latest and latest[key] >= ts:
                continue
            latest[key] = ts

            rx_kbps = fnum(pick(r, "rx_kbps"))
            tx_kbps = fnum(pick(r, "tx_kbps"))
            # bw_down / bw_up are the CONFIGURED circuit bandwidth in Mbps --
            # the contracted rate, not the port speed. This is the good
            # denominator, and it means wan_links.json is an override rather
            # than a prerequisite.
            #
            # Note what is NOT used: down_capacity_percentage. vManage
            # computes it by dividing kbps by Mbps without converting, so a
            # 1,746 kbps flow on a 100 Mbps circuit is reported as 1746%
            # rather than 1.7%. Utilisation is recomputed here from the raw
            # numbers instead.
            out[key] = {
                "rx_bps": rx_kbps * 1000.0 if rx_kbps is not None else None,
                "tx_bps": tx_kbps * 1000.0 if tx_kbps is not None else None,
                "bw_down_bps": (fnum(pick(r, "bw_down")) or 0) * 1e6 or None,
                "bw_up_bps": (fnum(pick(r, "bw_up")) or 0) * 1e6 or None,
                "rx_errors": fnum(pick(r, "rx_errors")),
                "tx_errors": fnum(pick(r, "tx_errors")),
                "rx_drops": fnum(pick(r, "rx_drops")),
                "tx_drops": fnum(pick(r, "tx_drops")),
                "oper": is_up(pick(r, "oper_status")),
                "admin": is_up(pick(r, "admin_status")),
                "iftype": as_str(pick(r, "interface_type"), "unknown"),
                "age": max(0.0, time.time() - ts / 1000.0) if ts else None,
            }

    stats_truncated.set(truncated)
    stats_interfaces_seen.set(len(out))
    protocol_available.labels(protocol="stats_interface").set(1 if out else 0)
    if truncated:
        log.warning("%d of %d statistics batches hit the %d-row cap; reduce "
                    "STATS_DEVICE_BATCH or STATS_WINDOW_HOURS",
                    truncated, len(batches), STATS_ROW_CAP)
    if not out:
        log.warning("no interface statistics returned; WAN throughput and "
                    "utilisation will be absent (link up/down is unaffected)")
    return out


def collect_approute_statistics(vm):
    """(hostname, local_color) -> best latency, jitter and loss.

    Path SLA in SD-WAN is a property of a tunnel, not of an interface. Every
    tunnel leaving a circuit shares that circuit's local colour, so folding
    by colour gives a fair statement about the circuit.

    BEST across tunnels, not worst: one distant peer with 300ms says
    something about that peer, whereas the best figure achievable over the
    circuit says something about the circuit. Worst-case belongs on the
    per-tunnel BFD panel, where the remote end is named.
    """
    out = {}
    if not (STATS_ENABLED and STATS_APPROUTE):
        return out

    body = stats_time_query(STATS_WINDOW_HOURS)
    data = stats_fetch(vm, "stats_approute",
                       "/dataservice/statistics/approute", body)
    for r in data:
        host = pick(r, "host_name", "vdevice_name")
        colour = pick(r, "local_color")
        if not host or not colour:
            continue
        key = (as_str(host), as_str(colour))
        lat = fnum(pick(r, "latency"))
        jit = fnum(pick(r, "jitter"))
        loss = fnum(pick(r, "loss_percentage"))
        cur = out.setdefault(key, {"latency": None, "jitter": None, "loss": None})
        for name, val in (("latency", lat), ("jitter", jit), ("loss", loss)):
            if val is None:
                continue
            if cur[name] is None or val < cur[name]:
                cur[name] = val

    protocol_available.labels(protocol="stats_approute").set(1 if out else 0)
    stats_approute_seen.set(len(out))
    return out


def first_working_with_fields(vm, signal_name, candidates, required=()):
    """Like first_working(), but a candidate must also CARRY the fields.

    The distinction matters and cost a deployment cycle to learn.
    ControlLocalProperty answers with HTTP 200 and hundreds of rows, so a
    row-count test accepts it -- but it is a per-device control-plane summary
    with no interface column anywhere in it. Accepting it produced an empty
    TLOC map and made every WAN link vanish, with no error anywhere to say so.

    An endpoint that answers healthily with the wrong shape is more dangerous
    than one that errors, because nothing in the logs looks wrong.
    """
    for path in candidates:
        payload = vm.get(signal_name, path + "?count=%d" % PAGE_SIZE)
        data = rows(payload)
        if not data:
            endpoint_available.labels(signal=signal_name, path=path).set(0)
            continue

        keys = set()
        for r in data[:100]:
            if isinstance(r, dict):
                keys.update(r.keys())
        missing = [f for f in required if f not in keys]
        if missing:
            endpoint_available.labels(signal=signal_name, path=path).set(0)
            log.warning(
                "%s returned %d rows but carries none of %s -- wrong entity "
                "for signal '%s', trying the next candidate",
                path.rsplit("/", 1)[-1], len(data), ", ".join(missing),
                signal_name)
            continue

        endpoint_available.labels(signal=signal_name, path=path).set(1)
        for other in candidates:
            if other != path:
                endpoint_available.labels(signal=signal_name, path=other).set(0)
        log.info("signal '%s' resolved to %s (%d rows)",
                 signal_name, path.rsplit("/", 1)[-1], len(data))
        return data, path

    for path in candidates:
        endpoint_available.labels(signal=signal_name, path=path).set(0)
    return [], None


def fnum(v, default=None):
    try:
        return float(v)
    except (TypeError, ValueError):
        return default


def pick(row, *names, **kw):
    """First key present with a value that is neither None nor empty string.

    row.get("vpn-id", "0") is NOT this. dict.get returns the default only when
    the key is ABSENT, so a JSON null -- which vManage emits routinely on
    cEdge state rows -- came through as the literal None and str(None) became
    the label value "None". Every recording rule filtering on vpn_id="0" then
    matched nothing, which is the second half of the missing-WAN-link bug.
    """
    default = kw.get("default")
    for n in names:
        if n in row:
            v = row[n]
            if v is not None and v != "":
                return v
    return default


def as_str(v, default="unknown"):
    if v is None or v == "":
        return default
    return str(v)


def epoch_ms_to_seconds_ago(v):
    ms = fnum(v)
    if not ms:
        return None
    # Values below ~1e11 are almost certainly already a duration in seconds
    # rather than an epoch timestamp in milliseconds.
    if ms < 1e11:
        return max(0.0, ms)
    return max(0.0, time.time() - ms / 1000.0)


# ---------------------------------------------------------------------------
# Collection
# ---------------------------------------------------------------------------

CANDIDATES = {
    # Order matters for merge_all: platform-specific entities first so their
    # richer rows win the deduplication against the generic entity.
    "interface": ["/dataservice/data/device/state/InterfaceCEdge",
                  "/dataservice/data/device/state/InterfaceVEdge",
                  "/dataservice/data/device/state/Interface"],
    # Per-colour local TLOC properties: the authoritative statement of which
    # interfaces actually terminate SD-WAN transport, and what colour each is.
    # ControlWanInterface FIRST, and the ordering here is a bug fix, not a
    # preference. ControlLocalProperty returns HTTP 200 with plenty of rows,
    # so a "first candidate that answers" probe accepts it and stops -- but
    # its rows are per-DEVICE control-plane summary (board-serial,
    # certificate-status, number-active-wan-interfaces). There is no
    # interface column in it at all. Accepting it yields an empty TLOC map
    # and every WAN link silently disappears.
    #
    # The lesson, learned the expensive way: "returned rows" is not "is the
    # right entity". collect_tlocs() now validates that the required fields
    # are actually present before accepting a candidate.
    "tloc": ["/dataservice/data/device/state/ControlWanInterface",
             "/dataservice/data/device/state/ControlLocalProperty",
             "/dataservice/data/device/state/ControlLocalProperties",
             "/dataservice/data/device/state/ControlWanInterfaceCEdge",
             "/dataservice/data/device/state/ControlWanInterfaceVEdge"],
    "omp": ["/dataservice/data/device/state/OMPPeer",
            "/dataservice/data/device/state/OMPPeers"],
    "bfd": ["/dataservice/data/device/state/BFDSessions",
            "/dataservice/data/device/state/BFDSession"],
    # BGP entity naming varies more than the others. Both obvious spellings
    # returned nothing on a 20.15 controller, so the list is deliberately
    # wide -- the exporter uses whichever answers and records the result in
    # vmanage_endpoint_available.
    # CEdgeBGPNeighbor first: a 20.15 controller running IOS-XE SD-WAN edges
    # exposes it under that name, which the realtime response reveals via
    # its preferenceKey "grid-CEdgeBGPNeighbor". vEdge fabrics use the
    # unprefixed spelling, so both stay in the list.
    "bgp": ["/dataservice/data/device/state/CEdgeBGPNeighbor",
            "/dataservice/data/device/state/VEdgeBGPNeighbor",
            "/dataservice/data/device/state/BGPNeighbor",
            "/dataservice/data/device/state/BGPNeighbors",
            "/dataservice/data/device/state/BgpNeighbor"],
    # OSPF: same split as interfaces, so this is merged rather than raced.
    "ospf": ["/dataservice/data/device/state/CEdgeOspfNeighbor",
             "/dataservice/data/device/state/OspfNeighbor",
             "/dataservice/data/device/state/OSPFNeighbor",
             "/dataservice/data/device/state/OspfNeighbors"],
    # EIGRP: several builds expose no bulk state entity at all. All plausible
    # spellings are probed; if none answer the exporter says so explicitly
    # through vmanage_protocol_data_available rather than emitting nothing.
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

REACH_VALUE = {"reachable": 1.0, "staging": 0.5, "unreachable": 0.0}

# Control-plane elements. They appear in the device list and in the TLOC
# table alongside the edges, but they are not branch circuits.
CONTROLLER_TYPES = {"vmanage", "vsmart", "vbond", "controller"}

UP_VALUES = ("up", "if-oper-state-ready", "ready", "if-state-up", "true", "1")

# Route table cache for the /routes endpoint. Prefix-level data would be
# millions of series in Prometheus; it is served on demand instead.
_route_cache = {}
_route_cache_lock = threading.Lock()
_last_cycle_stats = {}


def is_up(value):
    return 1.0 if str(value or "").strip().lower() in UP_VALUES else 0.0


def norm_vpn(row):
    """Normalise the VPN identifier to a plain integer string."""
    v = pick(row, "vpn-id", "vpnId", "vpn_id", "vpn")
    if v is None:
        return "unknown"
    s = str(v).strip()
    if s.lower() in ("none", "null", ""):
        return "unknown"
    try:
        return str(int(float(s)))
    except ValueError:
        return s


def collect(vm):
    started = time.monotonic()
    stats = {}

    # --- devices ---------------------------------------------------------
    devices = rows(vm.get("device", "/dataservice/device"))
    if not devices:
        # Do NOT clear anything. A single failed device call used to wipe the
        # whole registry, so a transient vManage hiccup blanked every panel
        # for a full scrape interval and looked exactly like an outage.
        log.warning("no devices returned from vManage; keeping last known "
                    "values rather than blanking every panel")
        return False

    for m in (device_reachable, device_state_info, device_uptime,
              site_devices_total, site_devices_reachable, site_routers_total):
        m.clear()

    meta = {}
    site_tot, site_reach, site_rtr = {}, {}, {}

    for d in devices:
        host = pick(d, "host-name", "hostName", default="unknown")
        sysip = pick(d, "system-ip", "deviceId", default="unknown")
        lb = device_labels(host, sysip, d.get("device-type"), d.get("device-model"))
        meta[sysip] = lb
        if host and host != "unknown":
            meta[host] = lb
        # vManage state rows key on any of these depending on entity; index
        # them all so lookup() below cannot miss.
        for alt in (d.get("uuid"), d.get("deviceId"), d.get("local-system-ip")):
            if alt:
                meta.setdefault(alt, lb)

        reach = (d.get("reachability") or "unknown").lower()
        val = REACH_VALUE.get(reach, 0.0)
        device_reachable.labels(**lb).set(val)
        device_state_info.labels(reachability=reach,
                                 version=d.get("version", "unknown"), **lb).set(1)

        up = fnum(d.get("uptime-date"))
        if up:
            # vManage reports the boot time as epoch milliseconds.
            device_uptime.labels(**lb).set(max(0.0, time.time() - up / 1000.0))

        key = (lb["region"], lb["country"], lb["site_id"], lb["priority"])
        site_tot[key] = site_tot.get(key, 0) + 1
        if val == 1.0:
            site_reach[key] = site_reach.get(key, 0) + 1
        if lb["device_role"] == "ROUTER":
            site_rtr[key] = site_rtr.get(key, 0) + 1

    for key, n in site_tot.items():
        sl = dict(zip(("region", "country", "site_id", "priority"), key))
        site_devices_total.labels(**sl).set(n)
        site_devices_reachable.labels(**sl).set(site_reach.get(key, 0))
        site_routers_total.labels(**sl).set(site_rtr.get(key, 0))

    stats["devices"] = len(devices)
    stats["sites"] = len(site_tot)

    def lookup(row, signal="unknown"):
        hit = (meta.get(row.get("vdevice-name"))
               or meta.get(row.get("system-ip"))
               or meta.get(row.get("vdevice-host-name"))
               or meta.get(row.get("host-name"))
               or meta.get(row.get("vdeviceName"))
               or meta.get(row.get("device-model") and None))
        if hit is None:
            rows_unmatched.labels(signal=signal).inc()
        return hit

    tlocs = collect_tlocs(vm, lookup, stats)

    # Throughput comes from the statistics store, on its own slower cadence.
    # vManage aggregates statistics in batches minutes apart, so re-querying
    # every 60s returns the same numbers at real cost to the controller.
    if_stats = refresh_statistics(vm, meta, stats)

    (per_device, per_site, method_counts, no_capacity,
     iface_rows) = collect_interfaces(vm, lookup, tlocs, stats, if_stats)

    # When the TLOC table is available it is AUTHORITATIVE, not a fallback.
    # It is the device's own statement of which interfaces terminate
    # transport; the interface table is at best a proxy for that.
    #
    # Treating it as a fallback was wrong in a way the tests caught: on a
    # fabric whose state Interface entity holds controllers only, the vSmart
    # eth1 in VPN 0 is classified as a WAN circuit, wan_links becomes
    # non-zero, and the fallback never fires -- so the dashboard shows a
    # handful of controller management ports and none of the 1,400 real
    # circuits. A partial wrong answer suppressing the right one is worse
    # than no answer, because nothing looks broken.
    no_throughput = 0
    if tlocs:
        no_capacity, no_throughput = collect_wan_from_tlocs(
            tlocs, meta, if_stats, stats, per_device, per_site,
            method_counts, no_capacity, iface_rows)
    finalise_wan_rollups(per_device, per_site, method_counts, no_capacity,
                         no_throughput, stats, stats.get("interfaces", 0))

    collect_omp(vm, lookup, stats)
    bfd_quality = collect_bfd(vm, lookup, stats)
    # Path SLA: approute where it exists, BFD elsewhere -- merged per
    # circuit, not chosen wholesale. Preferring one source outright means a
    # fabric where approute covers some colours and not others loses the
    # BFD-derived figures for the rest, and a circuit silently drops off the
    # latency panel while still appearing on every other one.
    quality = dict(bfd_quality or {})
    quality.update(_approute_cache.get("data") or {})
    apply_wan_quality(quality)
    collect_bgp(vm, lookup, stats)
    collect_ospf(vm, lookup, stats)
    collect_eigrp(vm, lookup, stats)
    collect_routes(vm, lookup, stats)
    collect_control(vm, lookup, stats)

    elapsed = time.monotonic() - started
    collection_duration.observe(elapsed)
    last_success.set(time.time())
    _last_cycle_stats.clear()
    _last_cycle_stats.update(stats)
    _last_cycle_stats["duration_seconds"] = round(elapsed, 2)
    _last_cycle_stats["completed_at"] = time.strftime(
        "%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    log.info("cycle complete in %.1fs: %s", elapsed,
             ", ".join("%s=%s" % (k, v) for k, v in sorted(stats.items())))
    return True


# ---------------------------------------------------------------------------
# TLOC discovery -- the authoritative WAN interface list
# ---------------------------------------------------------------------------

_stats_cache = {"data": {}, "at": 0.0}
_approute_cache = {"data": {}, "at": 0.0}


def refresh_statistics(vm, meta, stats):
    """Refresh the throughput and path-quality caches on their own cadence.

    Returns the interface statistics map, cached between refreshes so a 60s
    poll cycle does not hammer a store the controller only updates every few
    minutes.
    """
    now = time.time()
    if not STATS_ENABLED:
        return {}

    if now - _stats_cache["at"] >= STATS_POLL_INTERVAL:
        # Query by hostname because that is what the statistics store keys on
        # (host_name), and it is also what our site parser understands.
        hostnames = sorted({lb["hostname"] for lb in meta.values()
                            if lb.get("hostname") and lb["hostname"] != "unknown"})
        t0 = time.monotonic()
        data = collect_interface_statistics(vm, hostnames)
        signal_duration.labels(signal="stats_interface").set(time.monotonic() - t0)
        if data:
            _stats_cache["data"] = data
            _stats_cache["at"] = now
            ages = [v["age"] for v in data.values() if v.get("age") is not None]
            if ages:
                stats_age_seconds.set(min(ages))
        else:
            # Keep the previous sample rather than blanking the panels. A
            # failed statistics query is not evidence that traffic stopped.
            _stats_cache["at"] = now

        t0 = time.monotonic()
        appr = collect_approute_statistics(vm)
        signal_duration.labels(signal="stats_approute").set(time.monotonic() - t0)
        if appr:
            _approute_cache["data"] = appr
            _approute_cache["at"] = now

    stats["stats_interfaces"] = len(_stats_cache["data"])
    stats["stats_paths"] = len(_approute_cache["data"])
    return _stats_cache["data"]


def finalise_wan_rollups(per_device, per_site, method_counts, no_capacity,
                         no_throughput, stats, source_rows):
    for method, n in method_counts.items():
        wan_discovery_method_count.labels(method=method).set(n)
    wan_links_without_capacity.set(no_capacity)
    wan_links_without_throughput.set(no_throughput)

    for key, counts in per_device.items():
        lb = dict(key)
        wan_links_total.labels(**lb).set(counts["total"])
        wan_links_up.labels(**lb).set(counts["up"])
    for key, counts in per_site.items():
        sl = dict(zip(("region", "country", "site_id", "priority"), key))
        site_wan_links_total.labels(**sl).set(counts["total"])
        site_wan_links_up.labels(**sl).set(counts["up"])

    total = sum(c["total"] for c in per_device.values())
    stats["wan_links"] = total
    if total == 0:
        log.error("ZERO WAN circuits discovered from %d source rows. Check "
                  "vmanage_wan_discovery_method_count and vmanage_"
                  "endpoint_available{signal=\"tloc\"}.", source_rows)


def collect_wan_from_tlocs(tlocs, meta, if_stats, stats,
                           per_device, per_site, method_counts, no_capacity,
                           iface_rows=None):
    """Build the WAN inventory from the TLOC table plus statistics.

    This is the path that matters on a fabric whose state Interface entity
    covers controllers only. The TLOC table lists, per device, every
    interface terminating a transport, with its colour, carrier and
    operational state -- which is the entire WAN inventory, sourced from the
    devices themselves rather than inferred from a VPN identifier.

    Throughput is joined in from the statistics store keyed on
    (hostname, interface). A circuit with no matching sample is still
    published with its state: an L1 needs to see that WAN2 is down far more
    urgently than they need its bitrate, and suppressing the row until
    throughput arrives would hide exactly the links that matter.
    """
    no_throughput = 0

    for (hostname, ifname), tloc in tlocs.items():
        lb = meta.get(hostname)
        if not lb:
            continue
        # Controllers have transport interfaces too -- a vSmart's eth1 is a
        # perfectly real TLOC. It is not a branch circuit, and putting it on
        # the WAN dashboard inflates the link count and buries the sites an
        # engineer is actually looking for.
        if str(lb.get("device_type", "")).lower() in CONTROLLER_TYPES:
            continue
        if WAN_EXCLUDE_REGEX.match(ifname):
            continue

        colour = tloc.get("color") or "none"
        st = dict(if_stats.get((hostname, ifname)) or {})
        # Statistics first, interface entity second. Merged per FIELD rather
        # than per source: a build that reports rates in statistics but
        # errors only on the interface row should yield both, not whichever
        # source happened to win.
        fallback = (iface_rows or {}).get((hostname, ifname)) or {}
        for field in ("rx_bps", "tx_bps", "rx_errors", "tx_errors",
                      "rx_drops", "tx_drops", "oper", "admin"):
            if st.get(field) is None and fallback.get(field) is not None:
                st[field] = fallback[field]

        # Operational state: prefer the TLOC's own view, fall back to the
        # statistics sample. The TLOC state describes the tunnel; that is the
        # thing an engineer is being paged about.
        oper = is_up(tloc.get("state")) if tloc.get("state") is not None \
            else st.get("oper", 0.0)
        admin = st.get("admin", oper)

        rx_bps = st.get("rx_bps")
        tx_bps = st.get("tx_bps")
        if rx_bps is None and tx_bps is None:
            no_throughput += 1

        # bw_down from the statistics store is the CONFIGURED circuit rate in
        # Mbps -- a real contracted denominator, not port speed. Feed it in
        # through the row so wan_capacity() can pick it up in precedence
        # order behind an explicit wan_links.json override.
        synthetic = dict(fallback.get("row") or {})
        configured_bps = st.get("bw_down_bps")
        speed_bps = fallback.get("speed_bps")

        no_capacity += emit_wan_link(
            lb, ifname, "0", colour, oper, admin, rx_bps, tx_bps, speed_bps,
            st.get("rx_errors"), st.get("tx_errors"),
            st.get("rx_drops"), st.get("tx_drops"),
            tloc, synthetic, "tloc", per_device, per_site, configured_bps)
        method_counts["tloc"] += 1

    log.info("WAN inventory: %d circuits from the TLOC table (%d without "
             "throughput)", method_counts["tloc"], no_throughput)
    return no_capacity, no_throughput


def collect_tlocs(vm, lookup, stats):
    """Map (hostname, ifname) -> {colour, transport, ip, state}.

    ControlLocalProperty is the fabric-wide form of
    "show sdwan control local-properties", which lists one row per configured
    TLOC: the interface, its colour, its private and public address, and
    whether the tunnel is operational. An interface appearing here IS a WAN
    circuit by definition -- no heuristic required, and it works identically
    on vEdge and cEdge, which is precisely what the vpn_id filter did not.
    """
    t0 = time.monotonic()
    data, path = first_working_with_fields(
        vm, "tloc", CANDIDATES["tloc"], required=("interface",))
    signal_duration.labels(signal="tloc").set(time.monotonic() - t0)
    tlocs = {}
    for r in data:
        lb = lookup(r, "tloc")
        if not lb:
            continue
        ifname = pick(r, "interface", "ifname", "index")
        if not ifname:
            continue
        colour = as_str(pick(r, "color", "colour"), "none")
        tlocs[(lb["hostname"], str(ifname))] = {
            "color": colour,
            "transport": as_str(pick(r, "carrier", "transport"), "unknown"),
            "ip": as_str(pick(r, "public-ip", "private-ip", "system-ip"), "unknown"),
            # "operation-state" is what ControlWanInterface actually emits;
            # "operational-state" is the ControlLocalProperty spelling. Both
            # are here because getting this wrong reports every live circuit
            # as down, which is louder than reporting none at all.
            "state": pick(r, "operation-state", "operational-state",
                          "admin-state", "state"),
            "restrict": pick(r, "restrict"),
        }
    stats["tlocs"] = len(tlocs)
    protocol_available.labels(protocol="tloc").set(1 if tlocs else 0)
    if not tlocs:
        log.warning("no TLOC rows from any of %s -- WAN discovery falls back "
                    "to VPN 0 and then to interface naming",
                    ", ".join(p.rsplit("/", 1)[-1] for p in CANDIDATES["tloc"]))
    return tlocs


# ---------------------------------------------------------------------------
# Interfaces and WAN links
# ---------------------------------------------------------------------------

def classify_wan(hostname, ifname, vpn_id, tlocs):
    """Decide whether an interface is a WAN circuit, and say how we decided.

    Returns (is_wan, method). The chain runs best-evidence-first so that a
    site whose circuit sits in a non-zero VPN, or whose TLOC is a loopback,
    is still monitored -- both are common in real estates and both were
    invisible to the old vpn_id == "0" test.
    """
    dev_over = _wan_overrides.get(hostname) or {}
    if ifname in dev_over:
        return True, "override"
    if (hostname, ifname) in tlocs:
        return True, "tloc"
    if vpn_id == "0" and not WAN_EXCLUDE_REGEX.match(ifname):
        return True, "vpn0"
    return False, ""


def collect_interfaces(vm, lookup, tlocs, stats, if_stats=None):
    t0 = time.monotonic()
    data = merge_all(
        vm, "interface", CANDIDATES["interface"],
        key_fn=lambda r: (str(pick(r, "vdevice-name", "system-ip", "host-name")),
                          str(pick(r, "ifname", "interface")),
                          norm_vpn(r)))
    signal_duration.labels(signal="interface").set(time.monotonic() - t0)
    interfaces_seen.set(len(data))
    protocol_available.labels(protocol="interface").set(1 if data else 0)

    if not data:
        log.error("no interface rows from ANY candidate entity -- WAN panels "
                  "will be empty. Run probe-vmanage-entities.py to find the "
                  "entity names this vManage build uses.")
        stats["interfaces"] = 0
        return {}, {}, {"override": 0, "tloc": 0, "vpn0": 0, "heuristic": 0}, 0, {}

    for m in (if_oper_up, if_admin_up, if_rx_bps, if_tx_bps, if_speed_bps,
              if_rx_errors, if_tx_errors, if_rx_drops, if_tx_drops,
              if_rx_packets, if_tx_packets,
              wan_link_up, wan_link_admin_up, wan_link_rx_bps, wan_link_tx_bps,
              wan_link_capacity_bps, wan_link_utilization, wan_link_info,
              wan_link_rx_errors, wan_link_tx_errors, wan_link_rx_drops,
              wan_link_tx_drops, wan_links_total, wan_links_up,
              site_wan_links_total, site_wan_links_up):
        m.clear()

    method_counts = {"override": 0, "tloc": 0, "vpn0": 0, "heuristic": 0}
    per_device = {}
    per_site = {}
    no_capacity = 0
    candidates_for_heuristic = []

    # Hosts whose circuits the TLOC table already describes. Their WAN links
    # are built there, from better evidence; emitting them here as well would
    # double-count the site rollups.
    tloc_hosts = {h for (h, _if) in tlocs}

    # Parsed interface rows, kept so the TLOC pass can borrow throughput for
    # any circuit the statistics store has no sample for. Statistics are the
    # better source, but "no statistics" must not mean "no throughput" when
    # the interface entity already told us the answer.
    iface_rows = {}

    for r in data:
        lb = lookup(r, "interface")
        if not lb:
            continue
        if str(lb.get("device_type", "")).lower() in CONTROLLER_TYPES:
            continue
        ifname = as_str(pick(r, "ifname", "interface"))
        vpn_id = norm_vpn(r)
        tloc = tlocs.get((lb["hostname"], ifname)) or {}
        colour = tloc.get("color") or as_str(pick(r, "color"), "none")

        il = dict(lb, ifname=ifname, vpn_id=vpn_id, color=colour)

        oper = is_up(pick(r, "if-oper-status", "ifOperStatus", "oper-status"))
        admin = is_up(pick(r, "if-admin-status", "ifAdminStatus", "admin-status"))

        rx_bps = fnum(pick(r, "rx-kbps", "rxKbps"))
        tx_bps = fnum(pick(r, "tx-kbps", "txKbps"))
        rx_bps = rx_bps * 1000.0 if rx_bps is not None else None
        tx_bps = tx_bps * 1000.0 if tx_bps is not None else None
        speed_mbps = fnum(pick(r, "speed-mbps", "speedMbps", "if-speed"))
        speed_bps = speed_mbps * 1e6 if speed_mbps else None

        rx_err = fnum(pick(r, "rx-errors", "rxErrors"))
        tx_err = fnum(pick(r, "tx-errors", "txErrors"))
        rx_drop = fnum(pick(r, "rx-drops", "rxDrops"))
        tx_drop = fnum(pick(r, "tx-drops", "txDrops"))
        rx_pkts = fnum(pick(r, "rx-packets", "rxPackets"))
        tx_pkts = fnum(pick(r, "tx-packets", "txPackets"))

        iface_rows[(lb["hostname"], ifname)] = {
            "rx_bps": rx_bps, "tx_bps": tx_bps, "speed_bps": speed_bps,
            "rx_errors": rx_err, "tx_errors": tx_err,
            "rx_drops": rx_drop, "tx_drops": tx_drop,
            "oper": oper, "admin": admin, "row": r,
        }

        is_wan, method = classify_wan(lb["hostname"], ifname, vpn_id, tlocs)
        if lb["hostname"] in tloc_hosts:
            is_wan = False

        # Legacy per-interface family, unchanged. LAN interfaces can be
        # suppressed for cardinality; WAN links never are.
        if is_wan or EXPORT_LAN_INTERFACES:
            if_oper_up.labels(**il).set(oper)
            if_admin_up.labels(**il).set(admin)
            for value, metric in ((rx_bps, if_rx_bps), (tx_bps, if_tx_bps),
                                  (speed_bps, if_speed_bps),
                                  (rx_err, if_rx_errors), (tx_err, if_tx_errors),
                                  (rx_drop, if_rx_drops), (tx_drop, if_tx_drops),
                                  (rx_pkts, if_rx_packets), (tx_pkts, if_tx_packets)):
                if value is not None:
                    metric.labels(**il).set(value)

        if not is_wan:
            # Hold on to plausible candidates in case NOTHING was classified
            # as WAN. Better to fall back on naming than to ship a blank
            # dashboard to an L1 engineer during an incident.
            if WAN_IFNAME_REGEX.match(ifname) and not WAN_EXCLUDE_REGEX.match(ifname):
                candidates_for_heuristic.append(
                    (lb, ifname, vpn_id, colour, oper, admin, rx_bps, tx_bps,
                     speed_bps, rx_err, tx_err, rx_drop, tx_drop, tloc, r))
            continue

        method_counts[method] += 1
        no_capacity += emit_wan_link(
            lb, ifname, vpn_id, colour, oper, admin, rx_bps, tx_bps, speed_bps,
            rx_err, tx_err, rx_drop, tx_drop, tloc, r, method,
            per_device, per_site)

    if sum(method_counts.values()) == 0 and candidates_for_heuristic:
        log.warning("no WAN circuit identified by override, TLOC or VPN 0; "
                    "falling back to interface naming for %d candidates. "
                    "Populate %s to make this deterministic.",
                    len(candidates_for_heuristic), WAN_LINKS_FILE)
        for (lb, ifname, vpn_id, colour, oper, admin, rx_bps, tx_bps, speed_bps,
             rx_err, tx_err, rx_drop, tx_drop, tloc, r) in candidates_for_heuristic:
            method_counts["heuristic"] += 1
            no_capacity += emit_wan_link(
                lb, ifname, vpn_id, colour, oper, admin, rx_bps, tx_bps,
                speed_bps, rx_err, tx_err, rx_drop, tx_drop, tloc, r,
                "heuristic", per_device, per_site)

    stats["interfaces"] = len(data)
    # Rollups are written once, after the TLOC pass has had its say, so a
    # site with circuits from both sources is counted once rather than twice.
    return per_device, per_site, method_counts, no_capacity, iface_rows


def wan_capacity(hostname, ifname, speed_bps, row, configured_bps=None):
    """Pick a denominator and say where it came from.

    Precedence is deliberate. A contracted rate is the only figure an engineer
    can act on: a 1 Gbps port carrying 200 Mbps on a 100 Mbps circuit is at
    200% of contract and 20% of port, and only one of those numbers describes
    an outage. Port speed is used last and labelled as such so no panel can
    imply a CIR it does not have.
    """
    over = (_wan_overrides.get(hostname) or {}).get(ifname) or {}
    cir_down = fnum(over.get("cir_down_mbps"))
    if cir_down:
        return cir_down * 1e6, "cir"

    # bw_down from the statistics store is the CONFIGURED circuit bandwidth,
    # not the port rate. It must be labelled "configured", because basis is
    # the label a panel uses to decide whether a percentage can be trusted --
    # calling a contracted rate "port_speed" makes an accurate number look
    # like a rough one, and the caveat then gets applied to the wrong figure.
    if configured_bps:
        return configured_bps, "configured"

    if USE_CONFIGURED_BANDWIDTH:
        bw = fnum(pick(row, "bandwidth-downstream", "bandwidthDownstream",
                       "bandwidth-upstream"))
        if bw:
            mult = 1e3 if BANDWIDTH_FIELD_UNIT == "kbps" else 1e6
            return bw * mult, "configured"

    if speed_bps:
        return speed_bps, "port_speed"
    return None, None


def emit_wan_link(lb, ifname, vpn_id, colour, oper, admin, rx_bps, tx_bps,
                  speed_bps, rx_err, tx_err, rx_drop, tx_drop, tloc, row,
                  method, per_device, per_site, configured_bps=None):
    """Publish one WAN circuit. Returns 1 if it has no usable denominator."""
    wl = dict(lb, link=ifname, color=colour)

    wan_link_up.labels(**wl).set(oper)
    wan_link_admin_up.labels(**wl).set(admin)
    if rx_bps is not None:
        wan_link_rx_bps.labels(**wl).set(rx_bps)
    if tx_bps is not None:
        wan_link_tx_bps.labels(**wl).set(tx_bps)
    for value, metric in ((rx_err, wan_link_rx_errors), (tx_err, wan_link_tx_errors),
                          (rx_drop, wan_link_rx_drops), (tx_drop, wan_link_tx_drops)):
        if value is not None:
            metric.labels(**wl).set(value)

    over = (_wan_overrides.get(lb["hostname"]) or {}).get(ifname) or {}
    site_default = _wan_site_defaults.get(lb["site_id"]) or {}
    wan_link_info.labels(
        provider=as_str(over.get("provider") or site_default.get("default_provider"),
                        "unknown"),
        circuit_id=as_str(over.get("circuit_id"), "unknown"),
        role=as_str(over.get("role"), "unknown"),
        transport=as_str(tloc.get("transport") or over.get("transport"), "unknown"),
        ip=as_str(tloc.get("ip") or pick(row, "ip-address", "ipv4-address",
                                         "private-ip"), "unknown"),
        vpn_id=vpn_id, method=method, **wl).set(1)

    missing = 0
    capacity, basis = wan_capacity(lb["hostname"], ifname, speed_bps, row,
                                   configured_bps)
    if capacity and capacity > 0:
        wan_link_capacity_bps.labels(basis=basis, **wl).set(capacity)
        busiest = max(rx_bps or 0.0, tx_bps or 0.0)
        # Utilisation is computed HERE rather than only in a recording rule.
        # The rule's join drops any link whose capacity series is absent, and
        # a dropped link is indistinguishable from a healthy one on a panel.
        wan_link_utilization.labels(basis=basis, **wl).set(
            100.0 * busiest / capacity)
    elif rx_bps is not None or tx_bps is not None:
        missing = 1

    dkey = tuple(sorted(lb.items()))
    d = per_device.setdefault(dkey, {"total": 0, "up": 0})
    d["total"] += 1
    d["up"] += int(oper)

    skey = (lb["region"], lb["country"], lb["site_id"], lb["priority"])
    s = per_site.setdefault(skey, {"total": 0, "up": 0})
    s["total"] += 1
    s["up"] += int(oper)
    return missing


def apply_wan_quality(bfd_quality):
    """Attach latency, jitter and loss to WAN circuits via local colour.

    Per-circuit SLA is not an interface property in SD-WAN -- it is measured
    per tunnel by BFD. Every tunnel leaving a given circuit shares that
    circuit's local colour, so the best figure across those tunnels is a fair
    statement about the circuit itself. Best rather than worst: one distant
    peer with poor latency says something about that peer, whereas the best
    achievable figure says something about the local circuit.
    """
    for m in (wan_link_latency_ms, wan_link_jitter_ms, wan_link_loss_percent):
        m.clear()
    if not bfd_quality:
        return
    # (hostname, color) -> best values. Interface identity is recovered from
    # the WAN link info series written moments ago in the same cycle.
    for sample in _iter_wan_link_identity():
        lb, ifname, colour = sample
        key = (lb["hostname"], colour)
        q = bfd_quality.get(key)
        if not q:
            continue
        wl = dict(lb, link=ifname, color=colour)
        if q.get("latency") is not None:
            wan_link_latency_ms.labels(**wl).set(q["latency"])
        if q.get("jitter") is not None:
            wan_link_jitter_ms.labels(**wl).set(q["jitter"])
        if q.get("loss") is not None:
            wan_link_loss_percent.labels(**wl).set(q["loss"])


def _iter_wan_link_identity():
    """Recover (device labels, link, colour) from the wan_link_up children."""
    out = []
    for labels_tuple in list(wan_link_up._metrics.keys()):
        values = dict(zip(WAN_LABELS, labels_tuple))
        link = values.pop("link")
        colour = values.pop("color")
        out.append((values, link, colour))
    return out


# ---------------------------------------------------------------------------
# OMP
# ---------------------------------------------------------------------------

def collect_omp(vm, lookup, stats):
    t0 = time.monotonic()
    data, path = first_working(vm, "omp", CANDIDATES["omp"])
    signal_duration.labels(signal="omp").set(time.monotonic() - t0)
    protocol_available.labels(protocol="omp").set(1 if data else 0)
    if not data:
        stats["omp_peers"] = 0
        return
    for m in (omp_peer_up, omp_peer_state_info, omp_routes_received,
              omp_routes_installed, omp_routes_sent, omp_peers_total,
              omp_peers_up):
        m.clear()

    omp_tot, omp_up = {}, {}
    for r in data:
        lb = lookup(r, "omp")
        if not lb:
            continue
        peer = as_str(pick(r, "peer", "peer-ip"))
        state = str(pick(r, "state", default="") or "").lower()
        up = 1.0 if state == "up" else 0.0
        peer_type = as_str(pick(r, "type", "peer-type"))
        omp_peer_up.labels(peer=peer, peer_type=peer_type,
                           domain_id=as_str(pick(r, "domain-id", default="0")),
                           **lb).set(up)
        omp_peer_state_info.labels(peer=peer, peer_type=peer_type,
                                   state=state or "unknown", **lb).set(1)
        rx = fnum(pick(r, "route-recv", "routes-received", "recv"))
        inst = fnum(pick(r, "route-inst", "routes-installed", "inst"))
        tx = fnum(pick(r, "route-sent", "routes-sent", "sent"))
        if rx is not None:
            omp_routes_received.labels(peer=peer, **lb).set(rx)
        if inst is not None:
            omp_routes_installed.labels(peer=peer, **lb).set(inst)
        if tx is not None:
            omp_routes_sent.labels(peer=peer, **lb).set(tx)
        k = tuple(sorted(lb.items()))
        omp_tot[k] = omp_tot.get(k, 0) + 1
        omp_up[k] = omp_up.get(k, 0) + up
    for k, n in omp_tot.items():
        lb = dict(k)
        omp_peers_total.labels(**lb).set(n)
        omp_peers_up.labels(**lb).set(omp_up.get(k, 0))
    stats["omp_peers"] = len(data)


# ---------------------------------------------------------------------------
# BFD
# ---------------------------------------------------------------------------

def collect_bfd(vm, lookup, stats):
    t0 = time.monotonic()
    data, path = first_working(vm, "bfd", CANDIDATES["bfd"])
    signal_duration.labels(signal="bfd").set(time.monotonic() - t0)
    protocol_available.labels(protocol="bfd").set(1 if data else 0)
    quality = {}
    if not data:
        stats["bfd_sessions"] = 0
        return quality
    for m in (bfd_session_up, bfd_session_uptime, bfd_session_latency_ms,
              bfd_session_jitter_ms, bfd_session_loss_percent,
              bfd_sessions_total, bfd_sessions_up):
        m.clear()

    bfd_tot, bfd_up = {}, {}
    for r in data:
        lb = lookup(r, "bfd")
        if not lb:
            continue
        up = is_up(pick(r, "state"))
        local_color = as_str(pick(r, "local-color", "localColor"))
        bl = dict(
            lb,
            remote_system_ip=as_str(pick(r, "system-ip", "dst-ip")),
            remote_site_id=as_str(pick(r, "site-id", default="unknown")),
            local_color=local_color,
            remote_color=as_str(pick(r, "color", "remote-color")),
            proto=as_str(pick(r, "proto")))

        latency = fnum(pick(r, "latency", "mean-latency"))
        jitter = fnum(pick(r, "jitter", "mean-jitter"))
        loss = fnum(pick(r, "loss", "loss-percentage", "pkt-loss-percentage"))

        # Aggregate the best figure per local colour so the WAN panels can
        # show per-circuit SLA without a second API call.
        q = quality.setdefault((lb["hostname"], local_color),
                               {"latency": None, "jitter": None, "loss": None})
        for name, value in (("latency", latency), ("jitter", jitter), ("loss", loss)):
            if value is not None and (q[name] is None or value < q[name]):
                q[name] = value

        if BFD_SESSION_DETAIL == "all" or up == 0.0:
            bfd_session_up.labels(**bl).set(up)
            uptime = epoch_ms_to_seconds_ago(pick(r, "uptime-date", "uptime"))
            if uptime is not None:
                bfd_session_uptime.labels(**bl).set(uptime)
            for value, metric in ((latency, bfd_session_latency_ms),
                                  (jitter, bfd_session_jitter_ms),
                                  (loss, bfd_session_loss_percent)):
                if value is not None:
                    metric.labels(**bl).set(value)

        k = tuple(sorted(lb.items()))
        bfd_tot[k] = bfd_tot.get(k, 0) + 1
        bfd_up[k] = bfd_up.get(k, 0) + up
    for k, n in bfd_tot.items():
        lb = dict(k)
        bfd_sessions_total.labels(**lb).set(n)
        bfd_sessions_up.labels(**lb).set(bfd_up.get(k, 0))
    stats["bfd_sessions"] = len(data)
    return quality


# ---------------------------------------------------------------------------
# BGP
# ---------------------------------------------------------------------------

def collect_bgp(vm, lookup, stats):
    t0 = time.monotonic()
    data, path = first_working(vm, "bgp", CANDIDATES["bgp"])
    signal_duration.labels(signal="bgp").set(time.monotonic() - t0)
    protocol_available.labels(protocol="bgp").set(1 if data else 0)
    if not data:
        stats["bgp_neighbors"] = 0
        return
    for m in (bgp_neighbor_up, bgp_neighbor_state_info, bgp_prefixes_received,
              bgp_neighbors_total, bgp_neighbors_up):
        m.clear()

    bgp_tot, bgp_up = {}, {}
    for r in data:
        lb = lookup(r, "bgp")
        if not lb:
            continue
        state = str(pick(r, "state", default="") or "").lower()
        # Established is the only healthy state. A peer in "active" or
        # "connect" is trying and failing -- as down as one that is idle.
        up = 1.0 if state == "established" else 0.0
        peer = as_str(pick(r, "peer-addr", "peer-address"))
        vpn = norm_vpn(r)
        bl = dict(lb, peer_addr=peer,
                  remote_as=as_str(pick(r, "as", "remote-as")),
                  vpn_id=vpn)
        bgp_neighbor_up.labels(**bl).set(up)
        bgp_neighbor_state_info.labels(state=state or "unknown", **bl).set(1)
        pfx = fnum(pick(r, "prefixes-received", "prefix-received"))
        if pfx is not None:
            bgp_prefixes_received.labels(peer_addr=peer, vpn_id=vpn, **lb).set(pfx)
        k = tuple(sorted(lb.items()))
        bgp_tot[k] = bgp_tot.get(k, 0) + 1
        bgp_up[k] = bgp_up.get(k, 0) + up
    for k, n in bgp_tot.items():
        lb = dict(k)
        bgp_neighbors_total.labels(**lb).set(n)
        bgp_neighbors_up.labels(**lb).set(bgp_up.get(k, 0))
    stats["bgp_neighbors"] = len(data)


# ---------------------------------------------------------------------------
# OSPF
# ---------------------------------------------------------------------------

# Full is the terminal state for a point-to-point or DR/BDR adjacency. 2-Way
# is terminal and CORRECT between two DROTHERs on a broadcast segment --
# flagging it red would generate a permanent false alarm on every LAN with
# more than two routers, so it is treated as healthy and the exact state is
# still published on the _info series for anyone who needs to see it.
OSPF_HEALTHY = ("full", "2-way", "2way", "full/dr", "full/bdr", "full/drother")


def collect_ospf(vm, lookup, stats):
    t0 = time.monotonic()
    data = merge_all(
        vm, "ospf", CANDIDATES["ospf"],
        key_fn=lambda r: (str(pick(r, "vdevice-name", "system-ip", "host-name")),
                          str(pick(r, "neighbor-id", "router-id", "nbr-router-id")),
                          str(pick(r, "interface", "ifname", default="")),
                          norm_vpn(r)))
    signal_duration.labels(signal="ospf").set(time.monotonic() - t0)
    protocol_available.labels(protocol="ospf").set(1 if data else 0)
    if not data:
        stats["ospf_neighbors"] = 0
        log.info("no OSPF data from this vManage build; the dashboard will "
                 "show 'Data not available from current collector'")
        return
    for m in (ospf_neighbor_up, ospf_neighbor_state_info, ospf_neighbor_uptime,
              ospf_dead_timer, ospf_neighbors_total, ospf_neighbors_up):
        m.clear()

    tot, up_count = {}, {}
    for r in data:
        lb = lookup(r, "ospf")
        if not lb:
            continue
        state = str(pick(r, "state", "nbr-state", "adjacency-state",
                         default="") or "").lower().strip()
        up = 1.0 if state.split("/")[0] in [s.split("/")[0] for s in OSPF_HEALTHY] else 0.0
        ol = dict(lb,
                  neighbor_id=as_str(pick(r, "neighbor-id", "nbr-router-id",
                                          "router-id", "neighbor")),
                  area_id=as_str(pick(r, "area-id", "area", "ospf-area")),
                  ifname=as_str(pick(r, "interface", "ifname", "if-name")),
                  vpn_id=norm_vpn(r))
        ospf_neighbor_up.labels(**ol).set(up)
        ospf_neighbor_state_info.labels(state=state or "unknown", **ol).set(1)

        uptime = epoch_ms_to_seconds_ago(pick(r, "uptime-date", "uptime", "up-time"))
        if uptime is not None:
            ospf_neighbor_uptime.labels(**ol).set(uptime)
        dead = fnum(pick(r, "dead-timer", "dead-time", "dead_timer"))
        if dead is not None:
            # Some builds report the dead timer in milliseconds.
            ospf_dead_timer.labels(**ol).set(dead / 1000.0 if dead > 600 else dead)

        k = tuple(sorted(lb.items()))
        tot[k] = tot.get(k, 0) + 1
        up_count[k] = up_count.get(k, 0) + up
    for k, n in tot.items():
        lb = dict(k)
        ospf_neighbors_total.labels(**lb).set(n)
        ospf_neighbors_up.labels(**lb).set(up_count.get(k, 0))
    stats["ospf_neighbors"] = len(data)


# ---------------------------------------------------------------------------
# EIGRP
# ---------------------------------------------------------------------------

def collect_eigrp(vm, lookup, stats):
    t0 = time.monotonic()
    data = merge_all(
        vm, "eigrp", CANDIDATES["eigrp"],
        key_fn=lambda r: (str(pick(r, "vdevice-name", "system-ip", "host-name")),
                          str(pick(r, "peer-address", "address", "peer-addr")),
                          str(pick(r, "interface", "ifname", default=""))))
    signal_duration.labels(signal="eigrp").set(time.monotonic() - t0)
    available = 1 if data else 0
    protocol_available.labels(protocol="eigrp").set(available)
    if not data:
        # Deliberate and important. Most vManage builds expose no bulk EIGRP
        # state entity; EIGRP is only reachable through the per-device
        # realtime API, which cannot be polled across a 7,000-device fabric
        # without harming the controller. Publishing 0 lets the dashboard say
        # so plainly instead of showing an empty panel that reads as "no
        # problems".
        stats["eigrp_neighbors"] = 0
        log.info("no EIGRP data from any candidate entity on this vManage "
                 "build; publishing vmanage_protocol_data_available"
                 "{protocol=\"eigrp\"} 0")
        return
    for m in (eigrp_neighbor_up, eigrp_neighbor_uptime, eigrp_neighbor_srtt_ms,
              eigrp_neighbor_queue, eigrp_neighbors_total, eigrp_neighbors_up):
        m.clear()

    tot, up_count = {}, {}
    for r in data:
        lb = lookup(r, "eigrp")
        if not lb:
            continue
        el = dict(lb,
                  peer_addr=as_str(pick(r, "peer-address", "address", "peer-addr")),
                  as_number=as_str(pick(r, "as-number", "as", "asn")),
                  ifname=as_str(pick(r, "interface", "ifname", "if-name")),
                  vpn_id=norm_vpn(r))
        # EIGRP state rows do not always carry an explicit state field; a
        # neighbour present in the table with a live hold timer IS up.
        state = str(pick(r, "state", default="") or "").lower()
        hold = fnum(pick(r, "hold-time", "hold", "holdtime"))
        if state:
            up = 1.0 if state in ("up", "established", "0") else 0.0
        else:
            up = 1.0 if (hold is None or hold > 0) else 0.0
        eigrp_neighbor_up.labels(**el).set(up)

        uptime = epoch_ms_to_seconds_ago(pick(r, "uptime-date", "uptime", "up-time"))
        if uptime is not None:
            eigrp_neighbor_uptime.labels(**el).set(uptime)
        srtt = fnum(pick(r, "srtt", "smooth-round-trip-time"))
        if srtt is not None:
            eigrp_neighbor_srtt_ms.labels(**el).set(srtt)
        q = fnum(pick(r, "q-count", "queue-count", "qcnt"))
        if q is not None:
            eigrp_neighbor_queue.labels(**el).set(q)

        k = tuple(sorted(lb.items()))
        tot[k] = tot.get(k, 0) + 1
        up_count[k] = up_count.get(k, 0) + up
    for k, n in tot.items():
        lb = dict(k)
        eigrp_neighbors_total.labels(**lb).set(n)
        eigrp_neighbors_up.labels(**lb).set(up_count.get(k, 0))
    stats["eigrp_neighbors"] = len(data)


# ---------------------------------------------------------------------------
# Route table
# ---------------------------------------------------------------------------

def collect_routes(vm, lookup, stats):
    """Counts into Prometheus, prefixes into a cache served at /routes.

    A 7,000-device fabric holds tens of millions of prefixes. Exporting them
    as time series would multiply the TSDB by three orders of magnitude to
    answer a question -- "what does this one router's table look like right
    now" -- that is never asked of history and never asked in aggregate. So
    Prometheus gets counts per VPN and protocol, which trend usefully and
    alert well, and the prefixes are served as JSON on demand.
    """
    if not ENABLE_ROUTES:
        protocol_available.labels(protocol="route").set(0)
        return
    t0 = time.monotonic()
    data = merge_all(
        vm, "route", CANDIDATES["route"],
        key_fn=lambda r: (str(pick(r, "vdevice-name", "system-ip", "host-name")),
                          norm_vpn(r),
                          str(pick(r, "prefix", "route-prefix", "address")),
                          str(pick(r, "protocol", "proto", default="")),
                          str(pick(r, "nexthop-addr", "nexthop", default=""))))
    signal_duration.labels(signal="route").set(time.monotonic() - t0)
    protocol_available.labels(protocol="route").set(1 if data else 0)
    if not data:
        stats["routes"] = 0
        return

    for m in (routes_total, route_table_size, default_route_present):
        m.clear()

    counts = {}
    sizes = {}
    defaults = {}
    cache = {}

    for r in data:
        lb = lookup(r, "route")
        if not lb:
            continue
        vpn = norm_vpn(r)
        proto = str(pick(r, "protocol", "proto", default="unknown")).lower()
        prefix = as_str(pick(r, "prefix", "route-prefix", "address"))
        length = pick(r, "prefix-length", "mask-length")
        if length is not None and "/" not in prefix:
            prefix = "%s/%s" % (prefix, length)

        dkey = tuple(sorted(lb.items()))
        counts[(dkey, vpn, proto)] = counts.get((dkey, vpn, proto), 0) + 1
        sizes[dkey] = sizes.get(dkey, 0) + 1
        defaults.setdefault((dkey, vpn), 0)
        if prefix in ("0.0.0.0/0", "0.0.0.0/0.0.0.0", "::/0"):
            defaults[(dkey, vpn)] = 1

        dev_routes = cache.setdefault(lb["hostname"], [])
        if len(dev_routes) < ROUTE_CACHE_MAX_PER_DEVICE:
            dev_routes.append({
                "vpn_id": vpn,
                "prefix": prefix,
                "protocol": proto,
                "nexthop": as_str(pick(r, "nexthop-addr", "nexthop",
                                       "nexthop-address"), ""),
                "interface": as_str(pick(r, "nexthop-if-name", "ifname",
                                         "interface"), ""),
                "distance": pick(r, "distance", "admin-distance", default=""),
                "metric": pick(r, "metric", default=""),
                "site_id": lb["site_id"],
                "region": lb["region"],
                "country": lb["country"],
            })

    for (dkey, vpn, proto), n in counts.items():
        routes_total.labels(vpn_id=vpn, protocol=proto, **dict(dkey)).set(n)
    for dkey, n in sizes.items():
        route_table_size.labels(**dict(dkey)).set(n)
    for (dkey, vpn), present in defaults.items():
        default_route_present.labels(vpn_id=vpn, **dict(dkey)).set(present)

    with _route_cache_lock:
        _route_cache.clear()
        _route_cache.update(cache)
    stats["routes"] = len(data)


# ---------------------------------------------------------------------------
# Control connections
# ---------------------------------------------------------------------------

def collect_control(vm, lookup, stats):
    t0 = time.monotonic()
    data, path = first_working(vm, "control", CANDIDATES["control"])
    signal_duration.labels(signal="control").set(time.monotonic() - t0)
    protocol_available.labels(protocol="control").set(1 if data else 0)
    if not data:
        stats["control_connections"] = 0
        return
    for m in (control_connections_up, control_connection_state):
        m.clear()

    ctrl = {}
    for r in data:
        lb = lookup(r, "control")
        if not lb:
            continue
        state = str(pick(r, "state", default="") or "").lower()
        up = 1.0 if state in ("up", "connect") else 0.0
        control_connection_state.labels(
            peer_type=as_str(pick(r, "peer-type", "type")),
            peer_system_ip=as_str(pick(r, "system-ip", "peer-system-ip")),
            local_color=as_str(pick(r, "local-color")),
            remote_color=as_str(pick(r, "remote-color", "color")),
            protocol=as_str(pick(r, "protocol", "proto")),
            **lb).set(up)
        if up:
            k = tuple(sorted(lb.items()))
            ctrl[k] = ctrl.get(k, 0) + 1
    for k, n in ctrl.items():
        control_connections_up.labels(**dict(k)).set(n)
    stats["control_connections"] = len(data)


# ---------------------------------------------------------------------------
# HTTP surface: /metrics, /routes, /healthz
# ---------------------------------------------------------------------------


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def _send(self, code, body, ctype="application/json"):
        if isinstance(body, str):
            body = body.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path in ("/metrics", "/"):
            self._send(200, generate_latest(REGISTRY), CONTENT_TYPE_LATEST)
            return
        if parsed.path == "/healthz":
            self._send(200, json.dumps({
                "status": "ok" if exporter_up._value.get() else "starting",
                "version": EXPORTER_VERSION,
                "last_cycle": _last_cycle_stats,
            }, indent=2))
            return
        if parsed.path == "/routes":
            self._routes(urllib.parse.parse_qs(parsed.query))
            return
        self._send(404, json.dumps({"error": "not found",
                                    "paths": ["/metrics", "/routes", "/healthz"]}))

    def _routes(self, q):
        device = (q.get("device") or [""])[0]
        vpn = (q.get("vpn") or [""])[0]
        proto = (q.get("protocol") or [""])[0].lower()
        prefix = (q.get("prefix") or [""])[0]
        try:
            limit = min(int((q.get("limit") or ["500"])[0]), 10000)
        except ValueError:
            limit = 500

        with _route_cache_lock:
            if not device:
                self._send(200, json.dumps(
                    {"devices": sorted(_route_cache.keys()),
                     "hint": "add ?device=<hostname> to fetch a table"},
                    indent=2))
                return
            table = list(_route_cache.get(device, []))

        out = [r for r in table
               if (not vpn or r["vpn_id"] == vpn)
               and (not proto or r["protocol"] == proto)
               and (not prefix or r["prefix"].startswith(prefix))]
        self._send(200, json.dumps({
            "device": device,
            "filters": {"vpn": vpn, "protocol": proto, "prefix": prefix},
            "returned": len(out[:limit]),
            "matched": len(out),
            "truncated": len(out) > limit,
            "routes": out[:limit],
        }, indent=2))

    def log_message(self, fmt, *args):
        log.debug("http %s", fmt % args)


def serve(port):
    srv = ThreadingHTTPServer(("", port), Handler)
    srv.daemon_threads = True
    t = threading.Thread(target=srv.serve_forever, name="http", daemon=True)
    t.start()
    return srv


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------


def loop(vm, stop):
    while not stop.is_set():
        started = time.monotonic()
        try:
            collect(vm)
        except Exception:
            log.exception("collection cycle raised")
        elapsed = time.monotonic() - started
        if elapsed > POLL_INTERVAL:
            log.warning("cycle took %.1fs, longer than the %ds interval",
                        elapsed, POLL_INTERVAL)
        stop.wait(max(5.0, POLL_INTERVAL - elapsed))
    exporter_up.set(0)


def main():
    missing = [n for n, v in (("VMANAGE_HOST", VMANAGE_HOST),
                              ("VMANAGE_USER", VMANAGE_USER),
                              ("VMANAGE_PASS", VMANAGE_PASS)) if not v]
    if missing:
        log.error("missing environment: %s", ", ".join(missing))
        return 1

    log.info("starting v%s: host=%s poll=%ds port=%d router_token=%s "
             "routes=%s lan_interfaces=%s bfd_detail=%s",
             EXPORTER_VERSION, VMANAGE_HOST, POLL_INTERVAL, LISTEN_PORT,
             ROUTER_TOKEN, ENABLE_ROUTES, EXPORT_LAN_INTERFACES,
             BFD_SESSION_DETAIL)
    load_sites(SITES_FILE)
    load_wan_links(WAN_LINKS_FILE)

    vm = VManage()
    try:
        vm.login()
    except RuntimeError as exc:
        log.error("LOGIN FAILED: %s", exc)
        return 1

    srv = serve(LISTEN_PORT)
    exporter_up.set(1)
    log.info("metrics on :%d/metrics, routes on :%d/routes, health on :%d/healthz",
             LISTEN_PORT, LISTEN_PORT, LISTEN_PORT)

    stop = threading.Event()

    def handle(signum, _frame):
        log.info("signal %s received, shutting down", signum)
        stop.set()

    signal.signal(signal.SIGTERM, handle)
    signal.signal(signal.SIGINT, handle)

    worker = threading.Thread(target=loop, args=(vm, stop),
                              name="collector", daemon=True)
    worker.start()
    while worker.is_alive():
        worker.join(timeout=1.0)
    try:
        srv.shutdown()
    except Exception:
        pass
    vm.logout()
    return 0


if __name__ == "__main__":
    sys.exit(main())
