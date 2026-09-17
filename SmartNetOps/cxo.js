/* ═══════════════════════════════════════════════════════════════
   SMART NETOPS HUB — CXO RUNTIME
   Shared scope state, API access, formatters and SVG renderers for
   the executive dashboard pages.

   CONTRACT NOTE
     This file adds no new backend endpoints and changes no payload
     shape. It reads the same /api/* surfaces the existing pages use
     and the same localStorage scope keys the sidebar already writes.
   ═══════════════════════════════════════════════════════════════ */
(function (global) {
  "use strict";

  /* ── origin ───────────────────────────────────────────────── */
  function proxyOrigin() {
    try {
      if (location.protocol === "http:" || location.protocol === "https:") {
        if (location.port === "8080") return "";
        return location.protocol + "//" + location.hostname + ":8080";
      }
    } catch (e) {}
    return "http://cussya5w.carcgl.com:8080";
  }

  var API = proxyOrigin();

  /* ── scope state ──────────────────────────────────────────── */
  /* REGION_KEY is deliberately distinct from the sidebar's site-scope
     keys: a CXO region filter is a viewing lens, not a site lock, and
     must not clobber the site selection the operational pages rely on. */
  var REGION_KEY = "cxoRegion";
  var RANGE_KEY  = "cxoRange";
  var REGIONS    = ["APAC", "EMEA", "AMER", "CHINA"];

  var RANGES = [
    { key: "1h",  label: "1H" },
    { key: "6h",  label: "6H" },
    { key: "24h", label: "24H" },
    { key: "7d",  label: "7D" },
    { key: "30d", label: "30D" },
    { key: "90d", label: "90D" },
    { key: "1y",  label: "1Y" }
  ];

  function getRegion() {
    try {
      var v = localStorage.getItem(REGION_KEY);
      return REGIONS.indexOf(v) >= 0 ? v : "";
    } catch (e) { return ""; }
  }
  function setRegion(r) {
    try {
      if (r && REGIONS.indexOf(r) >= 0) localStorage.setItem(REGION_KEY, r);
      else localStorage.removeItem(REGION_KEY);
    } catch (e) {}
  }
  function getRange() {
    try {
      var v = localStorage.getItem(RANGE_KEY);
      for (var i = 0; i < RANGES.length; i++) if (RANGES[i].key === v) return v;
    } catch (e) {}
    return "24h";
  }
  function setRange(r) { try { localStorage.setItem(RANGE_KEY, r); } catch (e) {} }

  /* ── fetch ────────────────────────────────────────────────── */
  function get(path, params) {
    var qs = [];
    Object.keys(params || {}).forEach(function (k) {
      var v = params[k];
      if (v === undefined || v === null || v === "") return;
      qs.push(encodeURIComponent(k) + "=" + encodeURIComponent(v));
    });
    var url = API + path + (qs.length ? "?" + qs.join("&") : "");
    return fetch(url, { headers: { Accept: "application/json" } })
      .then(function (res) {
        return res.json().catch(function () { return {}; })
          .then(function (body) { return { ok: res.ok, status: res.status, body: body }; });
      })
      .catch(function (err) {
        return { ok: false, status: 0, body: { error: String(err.message || err) } };
      });
  }

  function network(opts) {
    opts = opts || {};
    var sid = opts.siteId || "";
    return get("/api/network-global" + (sid ? "/" + encodeURIComponent(sid) : ""), {
      region: opts.region !== undefined ? opts.region : getRegion(),
      range: opts.range || getRange(),
      regions: opts.withRegions ? 1 : "",
      dc: opts.withDc ? 1 : ""
    });
  }

  function siteMap(region, refresh) {
    return get("/api/sites/geo", { region: region || "", refresh: refresh ? 1 : "" });
  }

  function mapsConfig() { return get("/api/maps/config", {}); }
  function diagnostics(region) { return get("/api/network-global/diag", { region: region || "" }); }

  /* ── formatters ───────────────────────────────────────────── */
  function num(v, dp) {
    if (v === null || v === undefined || !isFinite(v)) return "—";
    return Number(v).toLocaleString(undefined, {
      minimumFractionDigits: dp || 0, maximumFractionDigits: dp === undefined ? 0 : dp
    });
  }
  function pct(v, dp) {
    if (v === null || v === undefined || !isFinite(v)) return "—";
    return Number(v).toFixed(dp === undefined ? 1 : dp) + "%";
  }
  function bits(v) {
    if (v === null || v === undefined || !isFinite(v)) return "—";
    var u = ["bps", "Kbps", "Mbps", "Gbps", "Tbps"], i = 0, n = Number(v);
    while (Math.abs(n) >= 1000 && i < u.length - 1) { n /= 1000; i++; }
    return n.toFixed(n >= 100 || i === 0 ? 0 : 1) + " " + u[i];
  }
  function dur(seconds) {
    if (seconds === null || seconds === undefined || !isFinite(seconds)) return "—";
    var d = Math.floor(seconds / 86400);
    if (d >= 1) return d + "d " + Math.floor((seconds % 86400) / 3600) + "h";
    var h = Math.floor(seconds / 3600);
    if (h >= 1) return h + "h " + Math.floor((seconds % 3600) / 60) + "m";
    return Math.max(0, Math.floor(seconds / 60)) + "m";
  }
  function ago(iso) {
    if (!iso) return "—";
    var t = new Date(iso).getTime();
    if (!isFinite(t)) return "—";
    var s = Math.max(0, (Date.now() - t) / 1000);
    if (s < 60) return Math.floor(s) + "s ago";
    if (s < 3600) return Math.floor(s / 60) + "m ago";
    if (s < 86400) return Math.floor(s / 3600) + "h ago";
    return Math.floor(s / 86400) + "d ago";
  }
  function esc(s) {
    return String(s === null || s === undefined ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  /* Availability -> semantic band. One definition, used everywhere,
     so "green" means the same thing on every page. */
  function band(v, warnAt, badAt) {
    if (v === null || v === undefined || !isFinite(v)) return "idle";
    var w = warnAt === undefined ? 99 : warnAt;
    var b = badAt === undefined ? 95 : badAt;
    if (v >= w) return "ok";
    if (v >= b) return "warn";
    return "bad";
  }
  function bandInverse(v, warnAt, badAt) {
    if (v === null || v === undefined || !isFinite(v)) return "idle";
    if (v <= warnAt) return "ok";
    if (v <= badAt) return "warn";
    return "bad";
  }

  /* ── control bar ──────────────────────────────────────────── */
  /**
   * Renders the shared region + range control bar and wires it.
   * onChange({region, range}) fires on any selection.
   */
  function controls(mountId, onChange, opts) {
    opts = opts || {};
    var el = document.getElementById(mountId);
    if (!el) return null;

    var region = getRegion();
    var range = getRange();

    var regionBtns = ['<button type="button" data-region="" aria-pressed="' +
      (region === "" ? "true" : "false") + '">Global</button>'];
    REGIONS.forEach(function (r) {
      if (opts.hideChina && r === "CHINA") return;
      regionBtns.push('<button type="button" data-region="' + r + '" aria-pressed="' +
        (region === r ? "true" : "false") + '">' + r + "</button>");
    });

    var rangeBtns = RANGES.map(function (r) {
      return '<button type="button" data-range="' + r.key + '" aria-pressed="' +
        (range === r.key ? "true" : "false") + '">' + r.label + "</button>";
    });

    el.className = "cxo-controls";
    el.innerHTML =
      '<div class="grp"><span class="lbl">Region</span>' +
        '<div class="seg" role="group" aria-label="Region">' + regionBtns.join("") + "</div></div>" +
      (opts.noRange ? "" :
      '<div class="grp"><span class="lbl">Period</span>' +
        '<div class="seg" role="group" aria-label="Time range">' + rangeBtns.join("") + "</div></div>") +
      '<span class="spacer"></span>' +
      '<span class="lbl" id="' + mountId + '-status">—</span>';

    function fire() {
      if (typeof onChange === "function") {
        onChange({ region: getRegion(), range: getRange() });
      }
    }

    el.addEventListener("click", function (ev) {
      var b = ev.target.closest("button[data-region],button[data-range]");
      if (!b) return;
      if (b.hasAttribute("data-region")) {
        setRegion(b.getAttribute("data-region"));
        el.querySelectorAll("button[data-region]").forEach(function (x) {
          x.setAttribute("aria-pressed", x === b ? "true" : "false");
        });
      } else {
        setRange(b.getAttribute("data-range"));
        el.querySelectorAll("button[data-range]").forEach(function (x) {
          x.setAttribute("aria-pressed", x === b ? "true" : "false");
        });
      }
      fire();
    });

    return {
      status: function (text) {
        var s = document.getElementById(mountId + "-status");
        if (s) s.textContent = text;
      },
      fire: fire
    };
  }

  /* ── renderers ────────────────────────────────────────────── */

  function heroStat(o) {
    var cls = o.band || "idle";
    var delta = "";
    if (o.delta) {
      delta = '<span class="delta ' + esc(o.deltaDir || "flat") + '">' +
        (o.deltaDir === "up" ? "▲" : o.deltaDir === "down" ? "▼" : "•") +
        " " + esc(o.delta) + "</span>";
    }
    return '<div class="hero-stat ' + esc(cls) + '">' +
      '<span class="k">' + esc(o.label) + "</span>" +
      '<span class="v">' + esc(o.value) +
        (o.unit ? '<span class="unit">' + esc(o.unit) + "</span>" : "") + "</span>" +
      '<span class="sub">' + (o.sub ? esc(o.sub) : "") + " " + delta + "</span>" +
      "</div>";
  }

  /** Line/area chart. times are unix seconds, series is [{name,values,color}]. */
  function lineChart(el, times, seriesList, opts) {
    if (!el) return;
    opts = opts || {};
    var W = 760, H = opts.height || 210, P = { t: 14, r: 12, b: 24, l: 52 };

    var all = [];
    seriesList.forEach(function (s) {
      (s.values || []).forEach(function (v) { if (v !== null && isFinite(v)) all.push(v); });
    });
    if (!times || !times.length || !all.length) {
      el.innerHTML = '<div class="empty"><b>No data for this period</b>' +
        (opts.emptyHint || "Widen the time range, or check the metric source.") + "</div>";
      return;
    }

    var max = Math.max.apply(null, all) * 1.12 || 1;
    var iw = W - P.l - P.r, ih = H - P.t - P.b;
    var x = function (i) { return P.l + (times.length < 2 ? iw / 2 : (i / (times.length - 1)) * iw); };
    var y = function (v) { return P.t + ih - (v / max) * ih; };

    var parts = ['<svg class="' + (opts.large ? "chart-lg" : "chart") +
      '" viewBox="0 0 ' + W + " " + H + '" preserveAspectRatio="none" role="img">'];

    for (var g = 0; g <= 4; g++) {
      var gy = P.t + (g / 4) * ih;
      parts.push('<line class="gridline" x1="' + P.l + '" y1="' + gy.toFixed(1) +
        '" x2="' + (W - P.r) + '" y2="' + gy.toFixed(1) + '"/>');
      parts.push('<text class="axis" x="' + (P.l - 7) + '" y="' + (gy + 3).toFixed(1) +
        '" text-anchor="end">' +
        esc(opts.fmt ? opts.fmt(max * (1 - g / 4)) : num(max * (1 - g / 4))) + "</text>");
    }

    seriesList.forEach(function (s, si) {
      var col = s.color || (si === 0 ? "var(--cyan)" : "var(--violet)");
      var d = "", area = "", started = false;
      (s.values || []).forEach(function (v, i) {
        if (v === null || !isFinite(v)) return;
        var px = x(i).toFixed(1), py = y(v).toFixed(1);
        d += (started ? "L" : "M") + px + " " + py;
        area += (started ? "L" : "M" + px + " " + (P.t + ih) + "L") + px + " " + py;
        started = true;
      });
      if (!started) return;
      if (opts.area !== false) {
        area += "L" + x(s.values.length - 1).toFixed(1) + " " + (P.t + ih) + "Z";
        parts.push('<path d="' + area + '" fill="' + col + '" opacity=".10"/>');
      }
      parts.push('<path d="' + d + '" fill="none" stroke="' + col +
        '" stroke-width="1.9" stroke-linejoin="round" stroke-linecap="round"/>');
    });

    var tickIdx = [0, Math.floor(times.length / 2), times.length - 1];
    tickIdx.forEach(function (i, n) {
      if (i < 0 || i >= times.length) return;
      var dt = new Date(times[i] * 1000);
      var lbl = opts.dateLabels
        ? (dt.getMonth() + 1) + "/" + dt.getDate()
        : dt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      parts.push('<text class="axis" x="' + x(i).toFixed(1) + '" y="' + (H - 7) +
        '" text-anchor="' + (n === 0 ? "start" : n === 2 ? "end" : "middle") + '">' +
        esc(lbl) + "</text>");
    });

    parts.push("</svg>");
    el.innerHTML = parts.join("");
  }

  function sparkline(values, color) {
    var vals = (values || []).filter(function (v) { return v !== null && isFinite(v); });
    if (vals.length < 2) return '<svg class="spark" viewBox="0 0 200 62"></svg>';
    var max = Math.max.apply(null, vals), min = Math.min.apply(null, vals);
    var rng = (max - min) || 1;
    var d = vals.map(function (v, i) {
      return (i ? "L" : "M") + ((i / (vals.length - 1)) * 200).toFixed(1) + " " +
        (56 - ((v - min) / rng) * 50).toFixed(1);
    }).join("");
    var c = color || "var(--cyan)";
    return '<svg class="spark" viewBox="0 0 200 62" preserveAspectRatio="none">' +
      '<path d="' + d + "L200 62L0 62Z" + '" fill="' + c + '" opacity=".10"/>' +
      '<path d="' + d + '" fill="none" stroke="' + c + '" stroke-width="1.8"/></svg>';
  }

  function gauge(value, opts) {
    opts = opts || {};
    var v = (value === null || value === undefined || !isFinite(value)) ? null : Number(value);
    var r = 54, c = 2 * Math.PI * r;
    var frac = v === null ? 0 : Math.max(0, Math.min(1, v / (opts.max || 100)));
    var b = opts.band || band(v, opts.warnAt, opts.badAt);
    var col = b === "ok" ? "var(--ok)" : b === "warn" ? "var(--warn)"
            : b === "bad" ? "var(--bad)" : "var(--idle)";
    return '<svg class="gauge" viewBox="0 0 132 132" role="img">' +
      '<circle class="gauge-track" cx="66" cy="66" r="' + r + '"/>' +
      '<circle class="gauge-fill" cx="66" cy="66" r="' + r + '" stroke="' + col +
        '" stroke-dasharray="' + (frac * c).toFixed(1) + " " + c.toFixed(1) + '"/>' +
      '<text class="gauge-num" x="66" y="63">' +
        esc(v === null ? "—" : v.toFixed(opts.dp === undefined ? 1 : opts.dp) +
        (opts.suffix || "")) + "</text>" +
      '<text class="gauge-cap" x="66" y="84">' + esc(opts.cap || "") + "</text></svg>";
  }

  function barRow(label, value, maxValue, display, bandName) {
    var w = maxValue ? Math.max(0, Math.min(100, (value / maxValue) * 100)) : 0;
    return '<div class="bar-row"><span class="bl" title="' + esc(label) + '">' + esc(label) + "</span>" +
      '<span class="meter"><i class="' + esc(bandName || "ok") + '" style="width:' +
        w.toFixed(1) + '%"></i></span>' +
      '<span class="bv">' + esc(display) + "</span></div>";
  }

  function pill(text, bandName) {
    return '<span class="pill ' + esc(bandName || "idle") + '">' + esc(text) + "</span>";
  }

  function emptyState(title, body) {
    return '<div class="empty"><b>' + esc(title) + "</b>" + esc(body || "") + "</div>";
  }

  /** Shown on pages whose data source is not yet integrated. */
  function pendingState(source) {
    return '<div class="empty"><b>Awaiting data integration</b>' +
      "This view is built and ready. Connect " + esc(source) +
      " and the panels populate with no further frontend work." + "</div>";
  }

  global.CXO = {
    API: API, proxyOrigin: proxyOrigin,
    REGIONS: REGIONS, RANGES: RANGES,
    getRegion: getRegion, setRegion: setRegion,
    getRange: getRange, setRange: setRange,
    get: get, network: network, siteMap: siteMap,
    mapsConfig: mapsConfig, diagnostics: diagnostics,
    num: num, pct: pct, bits: bits, dur: dur, ago: ago, esc: esc,
    band: band, bandInverse: bandInverse,
    controls: controls,
    heroStat: heroStat, lineChart: lineChart, sparkline: sparkline,
    gauge: gauge, barRow: barRow, pill: pill,
    emptyState: emptyState, pendingState: pendingState
  };
})(window);
