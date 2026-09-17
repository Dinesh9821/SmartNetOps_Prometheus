/* ═══════════════════════════════════════════════════════════════
   viz.js — dashboard visualisation engine

   ⚠️  DEMO DATA. Every series below is synthetic, exactly like the
   hardcoded "45 / 99.9% / 127" numbers in the original dashboard.
   Swap `Feed.*` for your real endpoints and every widget goes live
   without touching the render code.
   ═══════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  var REDUCED = matchMedia('(prefers-reduced-motion: reduce)').matches;
  var C = { cyan: '#22D3EE', blue: '#3B82F6', violet: '#A78BFA',
            emerald: '#34D399', amber: '#FBBF24', rose: '#FB7185', teal: '#2DD4BF' };

  /* ── synthetic feed ───────────────────────────────────────── */
  var Feed = {
    seed: 7,
    rand: function () {                       // deterministic — no flicker on reload
      this.seed = (this.seed * 1103515245 + 12345) & 0x7fffffff;
      return this.seed / 0x7fffffff;
    },
    walk: function (n, base, vol, min, max) {
      var out = [], v = base;
      for (var i = 0; i < n; i++) {
        v += (this.rand() - 0.5) * vol;
        v = Math.max(min, Math.min(max, v));
        out.push(v);
      }
      return out;
    }
  };

  /* ── sparkline ────────────────────────────────────────────── */
  function sparkline(el, data, color) {
    var w = 100, h = 30, min = Math.min.apply(null, data), max = Math.max.apply(null, data);
    var span = (max - min) || 1;
    var pts = data.map(function (v, i) {
      return [(i / (data.length - 1)) * w, h - ((v - min) / span) * (h - 4) - 2];
    });
    var line = pts.map(function (p, i) { return (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1); }).join(' ');
    var area = line + ' L' + w + ' ' + h + ' L0 ' + h + ' Z';
    var id = 'sg' + Math.random().toString(36).slice(2, 8);

    el.innerHTML =
      '<svg viewBox="0 0 ' + w + ' ' + h + '" preserveAspectRatio="none" style="width:100%;height:30px;display:block">' +
        '<defs><linearGradient id="' + id + '" x1="0" y1="0" x2="0" y2="1">' +
          '<stop offset="0%" stop-color="' + color + '" stop-opacity=".38"/>' +
          '<stop offset="100%" stop-color="' + color + '" stop-opacity="0"/>' +
        '</linearGradient></defs>' +
        '<path d="' + area + '" fill="url(#' + id + ')"/>' +
        '<path d="' + line + '" fill="none" stroke="' + color + '" stroke-width="1.5" ' +
              'stroke-linecap="round" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>' +
        '<circle cx="' + pts[pts.length - 1][0].toFixed(1) + '" cy="' + pts[pts.length - 1][1].toFixed(1) + '" ' +
                'r="2" fill="' + color + '"><animate attributeName="opacity" values="1;.25;1" dur="2s" repeatCount="indefinite"/></circle>' +
      '</svg>';
  }

  /* ── streaming area chart ─────────────────────────────────── */
  function Stream(el, series) {
    var W = 760, H = 210, PAD = 26;
    var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
    svg.setAttribute('preserveAspectRatio', 'none');
    svg.style.cssText = 'width:100%;height:210px;display:block;overflow:visible';

    var defs = '';
    series.forEach(function (s, i) {
      defs += '<linearGradient id="sf' + i + '" x1="0" y1="0" x2="0" y2="1">' +
                '<stop offset="0%" stop-color="' + s.color + '" stop-opacity=".34"/>' +
                '<stop offset="100%" stop-color="' + s.color + '" stop-opacity="0"/>' +
              '</linearGradient>';
    });
    svg.innerHTML = '<defs>' + defs + '</defs><g class="grid"></g><g class="plot"></g>';
    el.innerHTML = '';
    el.appendChild(svg);

    // horizontal rules + axis labels
    var grid = '';
    for (var g = 0; g <= 4; g++) {
      var y = PAD + (g / 4) * (H - PAD * 2);
      grid += '<line x1="0" y1="' + y + '" x2="' + W + '" y2="' + y + '" stroke="rgba(148,163,184,.09)" stroke-width="1"/>' +
              '<text x="2" y="' + (y - 4) + '" fill="#5D6B80" font-size="9" font-family="JetBrains Mono">' +
                (100 - g * 25) + '%</text>';
    }
    svg.querySelector('.grid').innerHTML = grid;

    var plot = svg.querySelector('.plot');

    function draw() {
      var out = '';
      series.forEach(function (s, i) {
        var d = s.data, n = d.length;
        var pts = d.map(function (v, k) {
          return [(k / (n - 1)) * W, PAD + (1 - v / 100) * (H - PAD * 2)];
        });
        // Catmull-Rom → cubic bezier for a smooth, non-jagged curve
        var path = 'M' + pts[0][0] + ' ' + pts[0][1];
        for (var k = 0; k < pts.length - 1; k++) {
          var p0 = pts[k ? k - 1 : 0], p1 = pts[k], p2 = pts[k + 1], p3 = pts[k + 2] || p2;
          path += ' C' + (p1[0] + (p2[0] - p0[0]) / 6).toFixed(1) + ' ' + (p1[1] + (p2[1] - p0[1]) / 6).toFixed(1) +
                  ' ' + (p2[0] - (p3[0] - p1[0]) / 6).toFixed(1) + ' ' + (p2[1] - (p3[1] - p1[1]) / 6).toFixed(1) +
                  ' ' + p2[0].toFixed(1) + ' ' + p2[1].toFixed(1);
        }
        out += '<path d="' + path + ' L' + W + ' ' + H + ' L0 ' + H + ' Z" fill="url(#sf' + i + ')"/>' +
               '<path d="' + path + '" fill="none" stroke="' + s.color + '" stroke-width="2" ' +
                     'stroke-linecap="round" vector-effect="non-scaling-stroke" ' +
                     'style="filter:drop-shadow(0 0 7px ' + s.color + '99)"/>' +
               '<circle cx="' + pts[pts.length - 1][0] + '" cy="' + pts[pts.length - 1][1].toFixed(1) + '" ' +
                       'r="3.5" fill="' + s.color + '" style="filter:drop-shadow(0 0 6px ' + s.color + ')"/>';
      });
      plot.innerHTML = out;
    }

    draw();
    if (!REDUCED) {
      setInterval(function () {
        series.forEach(function (s) {
          var last = s.data[s.data.length - 1];
          var next = Math.max(s.min, Math.min(s.max, last + (Feed.rand() - 0.5) * s.vol));
          s.data.push(next);
          s.data.shift();
        });
        draw();
      }, 2000);
    }
    return { draw: draw };
  }

  /* ── radial gauge ─────────────────────────────────────────── */
  function gauge(el, value, label, unit, color) {
    var R = 52, CIRC = 2 * Math.PI * R, ARC = CIRC * 0.75;   // 270° dial
    var pct = Math.max(0, Math.min(1, value / 100));
    var id = 'gg' + Math.random().toString(36).slice(2, 8);

    el.innerHTML =
      '<svg viewBox="0 0 140 140" style="width:100%;max-width:150px;height:auto;display:block;margin:0 auto">' +
        '<defs><linearGradient id="' + id + '" x1="0" y1="0" x2="1" y2="1">' +
          '<stop offset="0%" stop-color="' + color + '"/>' +
          '<stop offset="100%" stop-color="' + C.violet + '"/>' +
        '</linearGradient></defs>' +
        '<g transform="rotate(135 70 70)">' +
          '<circle cx="70" cy="70" r="' + R + '" fill="none" stroke="rgba(148,163,184,.12)" ' +
                  'stroke-width="9" stroke-linecap="round" ' +
                  'stroke-dasharray="' + ARC + ' ' + CIRC + '"/>' +
          '<circle cx="70" cy="70" r="' + R + '" fill="none" stroke="url(#' + id + ')" ' +
                  'stroke-width="9" stroke-linecap="round" ' +
                  'stroke-dasharray="' + (ARC * pct) + ' ' + CIRC + '" ' +
                  'style="filter:drop-shadow(0 0 8px ' + color + 'cc);transition:stroke-dasharray 1.2s cubic-bezier(.16,1,.3,1)"/>' +
        '</g>' +
        '<text x="70" y="70" text-anchor="middle" fill="#F5F8FC" font-size="26" font-weight="700" ' +
              'font-family="JetBrains Mono" letter-spacing="-1">' + value + '</text>' +
        '<text x="70" y="87" text-anchor="middle" fill="#5D6B80" font-size="9.5" ' +
              'font-family="JetBrains Mono" letter-spacing="1.5">' + unit + '</text>' +
      '</svg>' +
      '<div style="text-align:center;margin-top:8px;font-size:11px;color:#98A5B8">' + label + '</div>';
  }

  /* ── 7×24 heatmap ─────────────────────────────────────────── */
  function heatmap(el) {
    var days = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
    var html = '<div class="hm">';
    for (var d = 0; d < 7; d++) {
      html += '<span class="hm-day">' + days[d] + '</span>';
      for (var h = 0; h < 24; h++) {
        // load peaks in business hours, dips overnight — a plausible shape
        var biz = Math.exp(-Math.pow(h - 14, 2) / 42);
        var wk = (d === 0 || d === 6) ? 0.35 : 1;
        var v = Math.min(1, biz * wk * (0.65 + Feed.rand() * 0.6));
        var col = v > 0.78 ? C.rose : v > 0.55 ? C.amber : v > 0.3 ? C.cyan : C.blue;
        html += '<i style="background:' + col + ';opacity:' + (0.1 + v * 0.85).toFixed(2) + '" ' +
                'title="' + days[d] + ' ' + String(h).padStart(2, '0') + ':00 · ' +
                Math.round(v * 100) + '% load"></i>';
      }
    }
    html += '</div>' +
      '<div class="hm-key"><span>00:00</span><span style="margin-left:auto">Low</span>' +
      '<i style="background:' + C.blue + ';opacity:.3"></i>' +
      '<i style="background:' + C.cyan + ';opacity:.55"></i>' +
      '<i style="background:' + C.amber + ';opacity:.75"></i>' +
      '<i style="background:' + C.rose + ';opacity:.95"></i>' +
      '<span>High</span></div>';
    el.innerHTML = html;
  }

  /* ── topology map ─────────────────────────────────────────── */
  function topology(el) {
    var nodes = [
      { id: 'core',  x: 260, y: 105, r: 22, label: 'Core',    st: 'ok' },
      { id: 'edge1', x: 110, y: 48,  r: 15, label: 'EDGE-01', st: 'ok' },
      { id: 'edge2', x: 110, y: 165, r: 15, label: 'EDGE-02', st: 'ok' },
      { id: 'fw',    x: 405, y: 48,  r: 15, label: 'FW-A',    st: 'warn' },
      { id: 'dc',    x: 405, y: 165, r: 15, label: 'DC-SW',   st: 'ok' },
      { id: 'wan',   x: 520, y: 105, r: 13, label: 'WAN',     st: 'crit' }
    ];
    var links = [['edge1','core'],['edge2','core'],['core','fw'],['core','dc'],['fw','wan'],['dc','wan']];
    var at = {};
    nodes.forEach(function (n) { at[n.id] = n; });
    var tint = { ok: C.emerald, warn: C.amber, crit: C.rose };

    var svg = '<svg viewBox="0 0 580 215" style="width:100%;height:215px;display:block;overflow:visible">';
    links.forEach(function (l, i) {
      var a = at[l[0]], b = at[l[1]];
      var bad = a.st === 'crit' || b.st === 'crit';
      var col = bad ? C.rose : 'rgba(148,163,184,.28)';
      svg += '<line x1="' + a.x + '" y1="' + a.y + '" x2="' + b.x + '" y2="' + b.y + '" ' +
             'stroke="' + col + '" stroke-width="1.5"/>';
      if (!REDUCED) {
        // packets in flight — the link is alive
        svg += '<circle r="2.6" fill="' + (bad ? C.rose : C.cyan) + '" ' +
               'style="filter:drop-shadow(0 0 5px ' + (bad ? C.rose : C.cyan) + ')">' +
               '<animateMotion dur="' + (2 + i * 0.35) + 's" repeatCount="indefinite" ' +
               'path="M' + a.x + ' ' + a.y + ' L' + b.x + ' ' + b.y + '"/></circle>';
      }
    });
    nodes.forEach(function (n) {
      var col = tint[n.st];
      svg += '<circle cx="' + n.x + '" cy="' + n.y + '" r="' + (n.r + 8) + '" fill="' + col + '" opacity=".09"/>' +
             '<circle cx="' + n.x + '" cy="' + n.y + '" r="' + n.r + '" fill="#0E131E" ' +
                     'stroke="' + col + '" stroke-width="1.8" ' +
                     'style="filter:drop-shadow(0 0 10px ' + col + '99)"/>';
      if (n.st !== 'ok' && !REDUCED) {
        svg += '<circle cx="' + n.x + '" cy="' + n.y + '" r="' + n.r + '" fill="none" stroke="' + col + '" stroke-width="1.5">' +
               '<animate attributeName="r" values="' + n.r + ';' + (n.r + 16) + '" dur="1.9s" repeatCount="indefinite"/>' +
               '<animate attributeName="opacity" values=".8;0" dur="1.9s" repeatCount="indefinite"/></circle>';
      }
      svg += '<text x="' + n.x + '" y="' + (n.y + n.r + 15) + '" text-anchor="middle" fill="#98A5B8" ' +
                   'font-size="9" font-family="JetBrains Mono" letter-spacing=".5">' + n.label + '</text>';
    });
    svg += '</svg>';
    el.innerHTML = svg;
  }

  /* ── event stream ─────────────────────────────────────────── */
  var EVENTS = [
    { s: 'crit', t: 'WAN uplink flapping', m: 'wan-edge-01 · 3 transitions in 5m' },
    { s: 'warn', t: 'FW-A CPU above 80%',  m: 'firewall-a · sustained 12m' },
    { s: 'ok',   t: 'Backup completed',     m: 'core-db · 1.2 TB in 41m' },
    { s: 'ok',   t: 'Config pushed',        m: '18 devices · 0 failures' },
    { s: 'warn', t: 'Latency above target', m: 'APAC → EMEA · 148ms p95' },
    { s: 'ok',   t: 'Security scan passed', m: '0 critical findings' }
  ];

  function stream(el) {
    var t = Date.now();
    el.innerHTML = EVENTS.map(function (e, i) {
      var ago = Math.round((i + 1) * 7 + Feed.rand() * 5);
      return '<div class="ev">' +
               '<span class="led ' + (e.s === 'ok' ? '' : e.s) + '"></span>' +
               '<div class="ev-body"><div class="ev-t">' + e.t + '</div>' +
               '<div class="ev-m">' + e.m + '</div></div>' +
               '<span class="ev-time mono">' + ago + 'm</span>' +
             '</div>';
    }).join('');
  }

  /* ── boot ─────────────────────────────────────────────────── */
  function init() {
    var $ = function (id) { return document.getElementById(id); };

    // KPI sparklines
    [['sp-servers', Feed.walk(24, 42, 3, 36, 48), C.cyan],
     ['sp-uptime',  Feed.walk(24, 99.9, .12, 99.4, 100), C.emerald],
     ['sp-users',   Feed.walk(24, 120, 14, 88, 150), C.violet],
     ['sp-latency', Feed.walk(24, 62, 12, 38, 96), C.amber]]
      .forEach(function (s) { if ($(s[0])) sparkline($(s[0]), s[1], s[2]); });

    // live throughput
    if ($('stream')) {
      Stream($('stream'), [
        { name: 'Ingress', color: C.cyan,   data: Feed.walk(48, 58, 9, 22, 92), min: 22, max: 92, vol: 9 },
        { name: 'Egress',  color: C.violet, data: Feed.walk(48, 38, 8, 14, 74), min: 14, max: 74, vol: 8 }
      ]);
    }

    if ($('g-health'))  gauge($('g-health'),  94, 'Fleet health',   'SCORE', C.emerald);
    if ($('g-latency')) gauge($('g-latency'), 62, 'p95 latency',    'MS',    C.cyan);
    if ($('g-error'))   gauge($('g-error'),   3,  'Error budget spent', '%',  C.rose);

    if ($('heatmap'))  heatmap($('heatmap'));
    if ($('topology')) topology($('topology'));
    if ($('events'))   stream($('events'));

    // resource meters fill after paint so the transition is visible
    setTimeout(function () {
      document.querySelectorAll('.meter > i[data-w]').forEach(function (b) {
        b.style.width = b.dataset.w + '%';
      });
    }, 120);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
