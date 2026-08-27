#!/usr/bin/env bash
#
# build.sh -- rebuild the Network Telemetry platform from scratch.
#
# Everything lands under ONE root, owned by the service account, with one
# exporter file per vendor. Nothing is installed into a second home
# directory, no second Python tree, no container runtime.
#
# WHAT IT DOES NOT TOUCH
#   /etc/network-telemetry/exporters.env -- your API credentials. Root-owned,
#   mode 640, deliberately OUTSIDE this tree. A rebuild must never be able to
#   destroy the one file that is painful to reconstruct, and credentials do
#   not belong in a directory you edit daily.
#
# IDEMPOTENT
#   Safe to re-run. Existing data and dashboards are left alone; binaries and
#   the venv are only rebuilt if absent or if --force is given.
#
# USAGE
#   ./build.sh              build or repair
#   ./build.sh --force      rebuild venv and re-download binaries
#   ./build.sh --check      verify only, change nothing
#   ./build.sh --clean      delete everything this platform put OUTSIDE the
#                           tree (/opt/network-telemetry, /root/.cache/pip,
#                           /tmp leftovers, the old /home/network-telemetry)
#                           and stop the old services. Frees the root
#                           filesystem. Never touches $ROOT or credentials.
#
set -euo pipefail

# ---------------------------------------------------------------------------
# Settings
# ---------------------------------------------------------------------------
ROOT="${ROOT:-/home/s-p.net.automation/Network_Telemetry}"
SVC_USER="${SVC_USER:-telemetry}"
SVC_GROUP="${SVC_GROUP:-telemetry}"
ENV_FILE="${ENV_FILE:-/etc/network-telemetry/exporters.env}"

PROM_VERSION="${PROM_VERSION:-2.53.5}"
GRAFANA_VERSION="${GRAFANA_VERSION:-11.6.1}"

VMANAGE_PORT_="${VMANAGE_PORT_:-9823}"
MERAKI_PORT_="${MERAKI_PORT_:-9824}"
PROM_PORT="${PROM_PORT:-9090}"
GRAFANA_PORT="${GRAFANA_PORT:-3000}"

FORCE=0
CHECK_ONLY=0
CLEAN=0
for arg in "$@"; do
  case "$arg" in
    --force) FORCE=1 ;;
    --check) CHECK_ONLY=1 ;;
    --clean) CLEAN=1 ;;
    -h|--help) sed -n '2,30p' "$0"; exit 0 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

# ---------------------------------------------------------------------------
# Keep ALL scratch space off the root filesystem
# ---------------------------------------------------------------------------
# The release tarballs are large -- Prometheus ~100 MB, Grafana ~400 MB -- and
# each is downloaded AND unpacked before anything is moved into place, so the
# transient cost is roughly double. mktemp defaults to /tmp and pip caches
# under $HOME/.cache; on a host whose root filesystem is tight, both fill it
# and the build dies partway through with a confusing "No space left on
# device" from tar rather than from the download.
#
# Everything is therefore redirected under $ROOT, which lives on the same
# filesystem as the install target. Set before any command that might use it.
export TMPDIR="${ROOT}/.tmp"
export TMP="$TMPDIR"
export TEMP="$TMPDIR"
export XDG_CACHE_HOME="${ROOT}/.cache"
export PIP_CACHE_DIR="${ROOT}/.cache/pip"
mkdir -p "$TMPDIR" "$PIP_CACHE_DIR" 2>/dev/null || true

STEP=0
say()  { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
ok()   { printf '    [ OK ] %s\n' "$*"; }
warn() { printf '    [WARN] %s\n' "$*"; }
die()  { printf '\n    [FAIL] %s\n\n' "$*" >&2; exit 1; }
step() { STEP=$((STEP+1)); say "$STEP. $*"; }

need_sudo() {
  sudo -n true 2>/dev/null || sudo true || die "sudo is required"
}

# ---------------------------------------------------------------------------
# 0. --clean : reclaim space consumed OUTSIDE this tree
# ---------------------------------------------------------------------------
# Earlier attempts installed under /opt and ran pip via sudo, which caches
# wheels in /root/.cache -- invisible from a normal shell and a common reason
# for a root filesystem quietly filling up. Tarballs unpacked in /tmp add to
# it. None of that is needed once the tree lives under $ROOT.
#
# This removes only paths this platform created. It never touches $ROOT, the
# credentials file, or anything else on the system.
if [ "$CLEAN" = 1 ]; then
  say "CLEAN -- reclaiming space outside $ROOT"
  need_sudo

  before="$(df -h / | awk 'NR==2{print $4}')"
  echo "    free on / before: $before"

  for path in \
      /opt/network-telemetry \
      /root/.cache/pip \
      /root/telemetry-rebuild-backup \
      /home/network-telemetry ; do
    if sudo test -e "$path"; then
      sz="$(sudo du -sh "$path" 2>/dev/null | cut -f1)"
      sudo rm -rf "$path" && ok "removed $path ($sz)"
    fi
  done

  # Leftover unpack directories from interrupted runs.
  sudo find /tmp -maxdepth 1 \( -name 'prometheus-*.linux-amd64*' \
       -o -name 'grafana-*.linux-amd64*' -o -name 'tmp.??????????' \) \
       -exec rm -rf {} + 2>/dev/null || true
  ok "cleared /tmp unpack leftovers"

  # Stop and remove the old services. Units are rewritten by a normal run,
  # so removing them here leaves nothing half-configured.
  for u in vmanage-exporter meraki-exporter prometheus grafana; do
    sudo systemctl stop "$u" 2>/dev/null || true
    sudo systemctl disable "$u" 2>/dev/null || true
  done
  sudo systemctl daemon-reload 2>/dev/null || true
  ok "old services stopped and disabled (unit files kept)"

  after="$(df -h / | awk 'NR==2{print $4}')"
  echo
  echo "    free on / after : $after   (was $before)"
  echo
  echo "    Now run:  ./build.sh"
  exit 0
fi

# ---------------------------------------------------------------------------
# 1. Pre-flight
# ---------------------------------------------------------------------------
step "Pre-flight checks"

[ -d "$ROOT" ] || die "ROOT $ROOT does not exist"
cd "$ROOT"
ok "root: $ROOT"

# Space check before downloading ~500 MB of tarballs. Failing here with a
# clear number beats failing halfway through tar with "No space left on
# device", which points at the wrong filesystem.
ROOT_FS_FREE="$(df -Pm "$ROOT" | awk 'NR==2{print $4}')"
SLASH_FREE="$(df -Pm / | awk 'NR==2{print $4}')"
ok "free space: $(( ROOT_FS_FREE / 1024 )) GB on $ROOT, $(( SLASH_FREE / 1024 )) GB on /"
if [ "$ROOT_FS_FREE" -lt 1500 ]; then
  die "need ~1.5 GB free on $ROOT, have ${ROOT_FS_FREE} MB. Run: ./build.sh --clean"
fi
ok "scratch space redirected to $TMPDIR (nothing is written to /tmp or /root)"

need_sudo
getent group "$SVC_GROUP" >/dev/null || die "group $SVC_GROUP missing"
getent passwd "$SVC_USER" >/dev/null || die "user $SVC_USER missing"
ok "service account: $SVC_USER:$SVC_GROUP"

sudo test -r "$ENV_FILE" || die "credentials file $ENV_FILE not readable"
for v in VMANAGE_HOST VMANAGE_USER VMANAGE_PASS MERAKI_API_KEY; do
  sudo grep -q "^$v=" "$ENV_FILE" || warn "$v not set in $ENV_FILE"
done
ok "credentials present: $ENV_FILE"

# The service account must be able to traverse into a home directory. Home
# dirs are commonly 0700, which silently breaks a service running as another
# user -- and the failure surfaces as a confusing "file not found" rather
# than a permission error.
HOME_DIR="$(dirname "$ROOT")"
PERMS="$(stat -c '%a' "$HOME_DIR")"
if [ "${PERMS:0:1}" = "7" ] && [ "${PERMS:1:1}" -lt 5 ] 2>/dev/null; then
  warn "$HOME_DIR is mode $PERMS; $SVC_USER cannot traverse it"
  if [ "$CHECK_ONLY" = 0 ]; then
    sudo chmod o+x "$HOME_DIR"
    ok "added o+x to $HOME_DIR"
  fi
fi

# ---------------------------------------------------------------------------
# 2. Pick an interpreter
# ---------------------------------------------------------------------------
step "Selecting Python interpreter"

PYBIN=""
for cand in python3.12 python3.11 python3.10 python3.9 python3.8 python3; do
  if command -v "$cand" >/dev/null 2>&1; then
    ver="$("$cand" -c 'import sys;print("%d.%d"%sys.version_info[:2])')"
    major="${ver%%.*}"; minor="${ver##*.}"
    if [ "$major" -eq 3 ] && [ "$minor" -ge 8 ]; then
      PYBIN="$(command -v "$cand")"; PYVER="$ver"; break
    fi
    [ -z "$PYBIN" ] && { PYBIN="$(command -v "$cand")"; PYVER="$ver"; }
  fi
done
[ -n "$PYBIN" ] || die "no python3 found"

PYMINOR="${PYVER##*.}"
ok "using $PYBIN (Python $PYVER)"

# This drives two decisions, so it is resolved once, here, rather than
# rediscovered as a confusing pip error later:
#   * prometheus-client 0.18+ requires >= 3.8; 0.17.1 is the last for 3.6.
#   * the official meraki SDK requires >= 3.8 and CANNOT run on 3.6.
if [ "$PYMINOR" -ge 8 ]; then
  PROM_CLIENT="prometheus-client==0.21.1"
  MERAKI_SDK_OK=1
else
  PROM_CLIENT="prometheus-client==0.17.1"
  MERAKI_SDK_OK=0
  warn "Python $PYVER cannot run the meraki SDK (needs >= 3.8)"
  warn "the vManage exporter is unaffected -- it is 3.6-compatible by design"
fi

# ---------------------------------------------------------------------------
# 3. Directory tree
# ---------------------------------------------------------------------------
step "Creating directory tree"

if [ "$CHECK_ONLY" = 0 ]; then
  mkdir -p "$ROOT"/{bin,etc,rules,logs,dashboards}
  mkdir -p "$ROOT"/data/{prometheus,grafana}
  mkdir -p "$ROOT"/grafana-provisioning/{dashboards,datasources}
fi
for d in bin etc rules logs data/prometheus data/grafana; do
  [ -d "$ROOT/$d" ] && ok "$d" || warn "$d missing"
done

# ---------------------------------------------------------------------------
# 4. Virtualenv
# ---------------------------------------------------------------------------
step "Building virtualenv"

if [ "$CHECK_ONLY" = 1 ]; then
  [ -x "$ROOT/venv/bin/python" ] && ok "venv present" || warn "venv missing"
elif [ ! -x "$ROOT/venv/bin/python" ] || [ "$FORCE" = 1 ]; then
  rm -rf "$ROOT/venv"
  "$PYBIN" -m venv "$ROOT/venv"
  # RHEL ships pip 9 inside 3.6 venvs, which cannot read modern wheel
  # metadata and reports new releases as "no matching distribution" -- a
  # message that looks like a network fault and is not.
  "$ROOT/venv/bin/pip" install --quiet --cache-dir "$PIP_CACHE_DIR" \
    --upgrade pip || warn "pip upgrade failed; continuing"
  "$ROOT/venv/bin/pip" install --quiet --cache-dir "$PIP_CACHE_DIR" \
    "$PROM_CLIENT" || die "failed to install $PROM_CLIENT"
  ok "venv built with $PROM_CLIENT"
else
  ok "venv already present (use --force to rebuild)"
fi

if [ -x "$ROOT/venv/bin/python" ]; then
  # prometheus_client exposes no __version__ attribute, so ask the package
  # metadata instead. Checking the attribute fails on a perfectly good
  # install, which is a verification step that manufactures its own failure.
  "$ROOT/venv/bin/python" - <<'PYCHK' || die "prometheus_client not importable"
import prometheus_client
from prometheus_client import Counter, Gauge, Histogram, REGISTRY, generate_latest
try:
    from importlib.metadata import version
    v = version("prometheus-client")
except Exception:
    v = "unknown"
print("    [ OK ] prometheus_client %s (Counter/Gauge/Histogram/REGISTRY present)" % v)
PYCHK
fi

if [ "$MERAKI_SDK_OK" = 1 ] && [ "$CHECK_ONLY" = 0 ]; then
  if ! "$ROOT/venv/bin/python" -c 'import meraki' 2>/dev/null; then
    "$ROOT/venv/bin/pip" install --quiet --cache-dir "$PIP_CACHE_DIR" meraki \
      && ok "meraki SDK installed" \
      || warn "meraki SDK install failed"
  else
    ok "meraki SDK present"
  fi
fi

# ---------------------------------------------------------------------------
# 5. Exporter sources -- one file each, at the root
# ---------------------------------------------------------------------------
step "Placing exporter sources"

place() {  # place <search-paths...> -> <dest>
  local dest="${!#}"
  local found=""
  for p in "${@:1:$#-1}"; do
    [ -f "$p" ] && { found="$p"; break; }
  done
  if [ -z "$found" ]; then
    warn "$(basename "$dest") not found; searched: ${*:1:$#-1}"
    return 1
  fi
  # Only copy when the source is not already the destination.
  if [ "$(readlink -f "$found")" != "$(readlink -f "$dest")" ]; then
    [ "$CHECK_ONLY" = 0 ] && cp "$found" "$dest"
  fi
  ok "$(basename "$dest") <- $found"
}

place "$ROOT/vmanage-exporter/vmanage_exporter.py" \
      "$ROOT/vmanage_exporter.py" \
      "$ROOT/vmanage_exporter.py" || true

place "$ROOT/meraki-exporter/exporter.py" \
      "$ROOT/meraki-exporter/meraki_exporter.py" \
      "$ROOT/meraki_exporter.py" \
      "$ROOT/meraki_exporter.py" || true

place "$ROOT/meraki-exporter/sites.json" \
      "$ROOT/etc/sites.json" \
      "$ROOT/etc/sites.json" || true

if [ -f "$ROOT/vmanage_exporter.py" ] && [ -x "$ROOT/venv/bin/python" ]; then
  "$ROOT/venv/bin/python" -m py_compile "$ROOT/vmanage_exporter.py" \
    && ok "vmanage_exporter.py compiles under Python $PYVER" \
    || die "vmanage_exporter.py does not compile under Python $PYVER"
fi

if [ -f "$ROOT/meraki_exporter.py" ] && [ "$MERAKI_SDK_OK" = 0 ]; then
  if grep -q '^import meraki\|^from meraki' "$ROOT/meraki_exporter.py"; then
    warn "meraki_exporter.py imports the meraki SDK, which needs Python >= 3.8."
    warn "It will NOT start on $PYVER. Either install a newer Python, or"
    warn "rewrite it against the REST API using urllib (stdlib only)."
  fi
fi

# ---------------------------------------------------------------------------
# 6. Prometheus and Grafana binaries
# ---------------------------------------------------------------------------
step "Fetching Prometheus $PROM_VERSION and Grafana $GRAFANA_VERSION"

fetch_prom() {
  local url="https://github.com/prometheus/prometheus/releases/download/v${PROM_VERSION}/prometheus-${PROM_VERSION}.linux-amd64.tar.gz"
  local tmp; tmp="$(mktemp -d -p "$TMPDIR")"
  curl -fsSL "$url" -o "$tmp/p.tgz" || { rm -rf "$tmp"; return 1; }
  tar xzf "$tmp/p.tgz" -C "$tmp"
  cp "$tmp/prometheus-${PROM_VERSION}.linux-amd64/prometheus" "$ROOT/bin/"
  cp "$tmp/prometheus-${PROM_VERSION}.linux-amd64/promtool" "$ROOT/bin/"
  chmod 0755 "$ROOT/bin/prometheus" "$ROOT/bin/promtool"
  rm -rf "$tmp"
}

fetch_grafana() {
  local url="https://dl.grafana.com/oss/release/grafana-${GRAFANA_VERSION}.linux-amd64.tar.gz"
  local tmp; tmp="$(mktemp -d -p "$TMPDIR")"
  curl -fsSL "$url" -o "$tmp/g.tgz" || { rm -rf "$tmp"; return 1; }
  tar xzf "$tmp/g.tgz" -C "$tmp"
  rm -rf "$ROOT/grafana"
  mv "$tmp/grafana-v${GRAFANA_VERSION}" "$ROOT/grafana" 2>/dev/null \
    || mv "$tmp/grafana-${GRAFANA_VERSION}" "$ROOT/grafana"
  rm -rf "$tmp"
}

if [ "$CHECK_ONLY" = 1 ]; then
  [ -x "$ROOT/bin/prometheus" ] && ok "prometheus binary present" || warn "prometheus missing"
  [ -x "$ROOT/grafana/bin/grafana" ] && ok "grafana present" || warn "grafana missing"
else
  if [ ! -x "$ROOT/bin/prometheus" ] || [ "$FORCE" = 1 ]; then
    fetch_prom && ok "prometheus + promtool installed" || die "prometheus download failed"
  else
    ok "prometheus already present"
  fi
  if [ ! -x "$ROOT/grafana/bin/grafana" ] || [ "$FORCE" = 1 ]; then
    if fetch_grafana; then
      ok "grafana installed"
    else
      # Not fatal. Prometheus and both exporters are the data pipeline;
      # Grafana is the window onto it and can be added later without
      # touching anything built above.
      warn "grafana download failed -- dl.grafana.com may be blocked here"
      warn "fetch it manually, untar to ${ROOT}/grafana, then re-run ./build.sh"
      warn "  https://dl.grafana.com/oss/release/grafana-${GRAFANA_VERSION}.linux-amd64.tar.gz"
    fi
  else
    ok "grafana already present"
  fi
fi
[ -x "$ROOT/bin/prometheus" ] && "$ROOT/bin/prometheus" --version 2>&1 | head -1 | sed 's/^/    /'

# ---------------------------------------------------------------------------
# 7. Configuration
# ---------------------------------------------------------------------------
step "Writing configuration"

if [ "$CHECK_ONLY" = 0 ] && { [ ! -f "$ROOT/etc/prometheus.yml" ] || [ "$FORCE" = 1 ]; }; then
cat > "$ROOT/etc/prometheus.yml" <<PROMCFG
# Prometheus configuration -- generated by build.sh
global:
  scrape_interval: 60s
  evaluation_interval: 60s
  external_labels:
    platform: network-telemetry

rule_files:
  - ${ROOT}/rules/*.yml

scrape_configs:
  - job_name: vmanage
    scrape_interval: 60s
    scrape_timeout: 30s
    static_configs:
      - targets: ['127.0.0.1:${VMANAGE_PORT_}']
        labels:
          source: vmanage
          resolution_s: '60'

  - job_name: meraki
    scrape_interval: 60s
    scrape_timeout: 30s
    static_configs:
      - targets: ['127.0.0.1:${MERAKI_PORT_}']
        labels:
          source: meraki
          resolution_s: '60'

  - job_name: prometheus
    static_configs:
      - targets: ['127.0.0.1:${PROM_PORT}']
PROMCFG
  ok "etc/prometheus.yml written"
else
  ok "etc/prometheus.yml left as-is"
fi

# Collect any rules already in the checkout into the single rules directory.
if [ "$CHECK_ONLY" = 0 ]; then
  for f in "$ROOT"/vmanage-wan-rules.yml "$ROOT"/unified-rules.yml \
           "$ROOT"/prometheus/rules/*.yml; do
    [ -f "$f" ] && cp -n "$f" "$ROOT/rules/" 2>/dev/null || true
  done
fi
RULECOUNT="$(find "$ROOT/rules" -name '*.yml' 2>/dev/null | wc -l)"
ok "rules files: $RULECOUNT"

if [ -x "$ROOT/bin/promtool" ] && [ "$RULECOUNT" -gt 0 ]; then
  # Validate BEFORE anything starts. A malformed rules file makes Prometheus
  # refuse its whole config, taking every dashboard down, not just the new one.
  for f in "$ROOT"/rules/*.yml; do
    "$ROOT/bin/promtool" check rules "$f" >/dev/null 2>&1 \
      && ok "rules ok: $(basename "$f")" \
      || warn "rules INVALID: $(basename "$f") -- run: $ROOT/bin/promtool check rules $f"
  done
fi

# Grafana datasource provisioning
if [ "$CHECK_ONLY" = 0 ]; then
cat > "$ROOT/grafana-provisioning/datasources/prometheus.yml" <<DSCFG
apiVersion: 1
datasources:
  - name: Prometheus
    uid: prometheus
    type: prometheus
    access: proxy
    url: http://127.0.0.1:${PROM_PORT}
    isDefault: true
    editable: false
DSCFG

cat > "$ROOT/grafana-provisioning/dashboards/dashboards.yml" <<DBCFG
apiVersion: 1
providers:
  - name: network-telemetry
    orgId: 1
    folder: Network
    type: file
    disableDeletion: false
    updateIntervalSeconds: 60
    allowUiUpdates: true
    options:
      path: ${ROOT}/dashboards
DBCFG

cat > "$ROOT/etc/grafana.ini" <<GFCFG
[paths]
data = ${ROOT}/data/grafana
logs = ${ROOT}/logs
provisioning = ${ROOT}/grafana-provisioning

[server]
http_addr = 0.0.0.0
http_port = ${GRAFANA_PORT}

[analytics]
reporting_enabled = false
check_for_updates = false
GFCFG
  ok "grafana provisioning + grafana.ini written"

  # Gather dashboard JSON from the checkout into the provisioned directory.
  for f in "$ROOT"/*.json "$ROOT"/dashboards/*.json \
           "$ROOT"/grafana/provisioning/dashboards/*.json; do
    [ -f "$f" ] && cp -n "$f" "$ROOT/dashboards/" 2>/dev/null || true
  done
fi
DASHCOUNT="$(find "$ROOT/dashboards" -name '*.json' 2>/dev/null | wc -l)"
ok "dashboards staged: $DASHCOUNT"

# ---------------------------------------------------------------------------
# 8. systemd units
# ---------------------------------------------------------------------------
step "Writing systemd units"

unit() {  # unit <name> <description> <exec>
  local name="$1" desc="$2" exec="$3"
  sudo tee "/etc/systemd/system/${name}.service" >/dev/null <<UNIT
[Unit]
Description=${desc}
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${SVC_USER}
Group=${SVC_GROUP}
EnvironmentFile=-${ENV_FILE}
Environment=HOME=${ROOT}
Environment=XDG_CACHE_HOME=${ROOT}/.cache
Environment=PYTHONDONTWRITEBYTECODE=1
Environment=SITES_FILE=${ROOT}/etc/sites.json
WorkingDirectory=${ROOT}
ExecStart=${exec}
Restart=on-failure
RestartSec=10

[Install]
WantedBy=multi-user.target
UNIT
  ok "${name}.service"
}

if [ "$CHECK_ONLY" = 0 ]; then
  unit vmanage-exporter "vManage SD-WAN exporter" \
    "${ROOT}/venv/bin/python -u ${ROOT}/vmanage_exporter.py"

  unit meraki-exporter "Meraki exporter" \
    "${ROOT}/venv/bin/python -u ${ROOT}/meraki_exporter.py"

  unit prometheus "Prometheus" \
    "${ROOT}/bin/prometheus --config.file=${ROOT}/etc/prometheus.yml --storage.tsdb.path=${ROOT}/data/prometheus --storage.tsdb.retention.time=30d --web.listen-address=0.0.0.0:${PROM_PORT} --web.enable-lifecycle"

  if [ -x "$ROOT/grafana/bin/grafana" ]; then
    unit grafana "Grafana" \
      "${ROOT}/grafana/bin/grafana server --homepath=${ROOT}/grafana --config=${ROOT}/etc/grafana.ini"
  fi

  sudo systemctl daemon-reload
  ok "systemd reloaded"
fi

# Note: --web.enable-lifecycle is set deliberately. Without it there is no way
# to reload rules except a full restart, and the previous setup lacked it --
# which is why a rules change meant a scrape gap.

# ---------------------------------------------------------------------------
# 9. Ownership
# ---------------------------------------------------------------------------
step "Setting ownership"

if [ "$CHECK_ONLY" = 0 ]; then
  # You own the tree so you can edit without sudo; the service account gets
  # access through the shared group. Files arriving root-owned in your own
  # directory is what caused half the confusion during the last rebuild.
  sudo chown -R "$(id -un):${SVC_GROUP}" "$ROOT"
  sudo chmod -R g+rwX,o-w "$ROOT"

  # Only these two need to be WRITTEN by the services themselves.
  sudo chown -R "${SVC_USER}:${SVC_GROUP}" "$ROOT/data" "$ROOT/logs"
  ok "tree owned by $(id -un):${SVC_GROUP}; data/ and logs/ by ${SVC_USER}"
fi

# ---------------------------------------------------------------------------
# 10. Tidy scratch
# ---------------------------------------------------------------------------
if [ "$CHECK_ONLY" = 0 ]; then
  rm -rf "${TMPDIR:?}"/* 2>/dev/null || true
fi

# ---------------------------------------------------------------------------
# 11. Summary
# ---------------------------------------------------------------------------
say "BUILD COMPLETE"
cat <<SUMMARY

  Root            ${ROOT}
  Python          ${PYBIN} (${PYVER})
  prometheus_client ${PROM_CLIENT}
  Meraki SDK      $([ "$MERAKI_SDK_OK" = 1 ] && echo "supported" || echo "NOT SUPPORTED on Python ${PYVER}")
  Rules files     ${RULECOUNT}
  Dashboards      ${DASHCOUNT}

  START IN THIS ORDER (exporters first, so Prometheus has targets):

    sudo systemctl enable --now vmanage-exporter
    sleep 90 && curl -s localhost:${VMANAGE_PORT_}/metrics | grep -c '^vmanage_wan_link_up{'

    sudo systemctl enable --now meraki-exporter
    curl -s localhost:${MERAKI_PORT_}/metrics | head -5

    sudo systemctl enable --now prometheus
    curl -sG 'http://localhost:${PROM_PORT}/api/v1/query' --data-urlencode 'query=up'

    sudo systemctl enable --now grafana
    # then browse to http://<host>:${GRAFANA_PORT}  (admin/admin on first login)

  VERIFY EVERYTHING:
    ./build.sh --check

  RECLAIM SPACE OUTSIDE THIS TREE (/opt, /root/.cache, /tmp, old home):
    ./build.sh --clean

  RELOAD PROMETHEUS RULES WITHOUT A RESTART:
    curl -X POST http://localhost:${PROM_PORT}/-/reload

  LOGS:
    sudo journalctl -u vmanage-exporter -f

SUMMARY
