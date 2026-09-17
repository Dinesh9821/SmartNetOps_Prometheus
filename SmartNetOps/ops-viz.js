(function (global) {
  "use strict";
  var C = { cyan: "#22D3EE", blue: "#3B82F6", violet: "#A78BFA", emerald: "#34D399",
            amber: "#FBBF24", rose: "#FB7185", teal: "#2DD4BF", indigo: "#6366F1" };

  function uid(p) { return p + Math.random().toString(36).slice(2, 8); }

  function polar(cx, cy, r, a) {
    var rad = (a - 90) * Math.PI / 180;
    return [cx + r * Math.cos(rad), cy + r * Math.sin(rad)];
  }

  function arcPath(cx, cy, r, a0, a1) {
    var s = polar(cx, cy, r, a0), e = polar(cx, cy, r, a1);
    var large = (a1 - a0) > 180 ? 1 : 0;
    return "M " + s[0].toFixed(2) + " " + s[1].toFixed(2) +
      " A " + r + " " + r + " 0 " + large + " 1 " + e[0].toFixed(2) + " " + e[1].toFixed(2);
  }

  function donut(el, pct, color, label, unit) {
    pct = Math.max(0, Math.min(100, Number(pct) || 0));
    var r = 52, circ = 2 * Math.PI * r, dash = circ * pct / 100, id = uid("dn");
    el.innerHTML =
      '<svg viewBox="0 0 140 140" class="viz-svg">' +
        '<defs><linearGradient id="' + id + '" x1="0" y1="0" x2="1" y2="1">' +
          '<stop offset="0%" stop-color="' + color + '"/>' +
          '<stop offset="100%" stop-color="#A78BFA"/>' +
        "</linearGradient></defs>" +
        '<circle cx="70" cy="70" r="' + r + '" fill="none" stroke="rgba(148,163,184,.14)" stroke-width="12"/>' +
        '<circle cx="70" cy="70" r="' + r + '" fill="none" stroke="url(#' + id + ')" stroke-width="12" ' +
          'stroke-linecap="round" transform="rotate(-90 70 70)" ' +
          'stroke-dasharray="' + dash.toFixed(1) + " " + circ.toFixed(1) + '" ' +
          'style="filter:drop-shadow(0 0 10px ' + color + "99)"/>' +
        '<text x="70" y="68" text-anchor="middle" class="viz-center">' + pct.toFixed(pct % 1 ? 1 : 0) + "</text>" +
        '<text x="70" y="86" text-anchor="middle" class="viz-unit">' + (unit || "%") + "</text>" +
      "</svg>" +
      (label ? '<div class="viz-cap">' + label + "</div>" : "");
  }

  function pie(el, slices) {
    var total = slices.reduce(function (s, x) { return s + x.value; }, 0) || 1;
    var html = '<svg viewBox="0 0 140 140" class="viz-svg">';
    var angle = 0;
    slices.forEach(function (sl) {
      var sweep = (sl.value / total) * 360;
      var a1 = angle + sweep;
      if (sweep >= 359.9) {
        html += '<circle cx="70" cy="70" r="54" fill="' + sl.color + '"/>';
      } else {
        var p0 = polar(70, 70, 54, angle), p1 = polar(70, 70, 54, a1);
        var large = sweep > 180 ? 1 : 0;
        html += '<path d="M70 70 L' + p0[0].toFixed(2) + " " + p0[1].toFixed(2) +
          " A 54 54 0 " + large + " 1 " + p1[0].toFixed(2) + " " + p1[1].toFixed(2) +
          ' Z" fill="' + sl.color + '" style="filter:drop-shadow(0 0 8px ' + sl.color + "66)"/>';
      }
      angle = a1;
    });
    html += '<circle cx="70" cy="70" r="30" fill="var(--surface,#0b1220)"/>' +
      '<text x="70" y="66" text-anchor="middle" class="viz-center viz-center-sm">' + Math.round(total) + "</text>" +
      '<text x="70" y="82" text-anchor="middle" class="viz-unit">total</text></svg>';
    html += '<div class="viz-legend">' + slices.map(function (sl) {
      return '<span><i style="background:' + sl.color + '"></i>' + sl.label + " · " + sl.value + "</span>";
    }).join("") + "</div>";
    el.innerHTML = html;
  }

  function spark(el, data, color) {
    var w = 240, h = 78, min = Math.min.apply(null, data), max = Math.max.apply(null, data);
    var span = (max - min) || 1;
    var pts = data.map(function (v, i) {
      return [(i / (data.length - 1)) * w, h - 8 - ((v - min) / span) * (h - 16)];
    });
    var d = pts.map(function (p, i) { return (i ? "L" : "M") + p[0].toFixed(1) + " " + p[1].toFixed(1); }).join(" ");
    var area = d + " L" + w + " " + h + " L0 " + h + " Z";
    var id = uid("sp");
    var last = data[data.length - 1];
    el.innerHTML =
      '<svg viewBox="0 0 ' + w + " " + h + '" preserveAspectRatio="none" class="viz-spark">' +
        '<defs><linearGradient id="' + id + '" x1="0" y1="0" x2="0" y2="1">' +
          '<stop offset="0%" stop-color="' + color + '" stop-opacity=".42"/>' +
          '<stop offset="100%" stop-color="' + color + '" stop-opacity="0"/>' +
        "</linearGradient></defs>" +
        '<path d="' + area + '" fill="url(#' + id + ')"/>' +
        '<path d="' + d + '" fill="none" stroke="' + color + '" stroke-width="2.2" stroke-linecap="round"/>' +
        '<circle cx="' + pts[pts.length - 1][0].toFixed(1) + '" cy="' + pts[pts.length - 1][1].toFixed(1) +
          '" r="3.2" fill="' + color + '"/>' +
      "</svg>";
    return last;
  }

  function bars(el, data, color) {
    var max = Math.max.apply(null, data) || 1;
    var w = 240, h = 78, gap = 4, bw = (w - gap * (data.length - 1)) / data.length;
    var html = '<svg viewBox="0 0 ' + w + " " + h + '" class="viz-spark">';
    data.forEach(function (v, i) {
      var bh = Math.max(4, (v / max) * (h - 10));
      html += '<rect x="' + (i * (bw + gap)).toFixed(1) + '" y="' + (h - bh).toFixed(1) +
        '" width="' + bw.toFixed(1) + '" height="' + bh.toFixed(1) + '" rx="3" fill="' + color +
        '" opacity="' + (0.45 + 0.55 * (v / max)).toFixed(2) + '"/>';
    });
    el.innerHTML = html + "</svg>";
  }

  function meter(el, pct, color) {
    pct = Math.max(0, Math.min(100, Number(pct) || 0));
    el.innerHTML = '<div class="viz-meter"><i style="width:' + pct + "%;background:linear-gradient(90deg," + color + ",#A78BFA);box-shadow:0 0 14px " + color + "88" + '"></i></div>';
  }

  function walk(n, base, vol, min, max) {
    var out = [], v = base, s = (base * 97 + 13) % 97;
    for (var i = 0; i < n; i++) {
      s = (s * 11 + 17) % 97;
      v += ((s / 97) - 0.5) * vol;
      v = Math.max(min, Math.min(max, v));
      out.push(Number(v.toFixed(2)));
    }
    return out;
  }

  global.OpsViz = { donut: donut, pie: pie, spark: spark, bars: bars, meter: meter, walk: walk, colors: C };
})(window);
