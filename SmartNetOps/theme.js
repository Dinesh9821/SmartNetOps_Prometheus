/* ═══════════════════════════════════════════════════════════════
   SMART NETOPS HUB — theme.js
   Presentation + navigation shell. Adds zero business logic,
   reads no data it doesn't already own, fails silently.
   ═══════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  try {
    var bootTheme = localStorage.getItem('netops-theme') || 'dark';
    if (bootTheme !== 'light' && bootTheme !== 'dark') bootTheme = 'dark';
    document.documentElement.setAttribute('data-theme', bootTheme);
  } catch (e) {}

  var REDUCED = matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* Every destination in the app. Single source of truth for
     the palette and the breadcrumb trail. */
  var ROUTES = [
    { id: 'landing page.html',       icon: '◈', name: 'Operations Home',    hint: 'Home',     crumb: 'Home' },
    { id: 'dashboard.html',          icon: '▦', name: 'Dashboard',          hint: 'Telemetry',crumb: 'Dashboard' },
    { id: 'monitoring.html',         icon: '◎', name: 'Monitoring',         hint: 'Telemetry',crumb: 'Monitoring' },
    { id: 'chatops.html',            icon: '◍', name: 'ChatOps',            hint: 'Assistant',crumb: 'ChatOps' },
    { id: 'netchatops.html',         icon: '◉', name: 'Network with Us',    hint: 'Assistant',crumb: 'Network with Us' },
    { id: 'Netautomation Flow.html', icon: '⟐', name: 'NetAutomation Flow', hint: 'Workflows',crumb: 'NetAutomation Flow' },
    { id: 'Network Diagram.html',    icon: '⬡', name: 'Network Diagram',    hint: 'Topology', crumb: 'Network Diagram' },
    { id: 'firewall.html',           icon: '⬛', name: 'Firewall',           hint: 'Security', crumb: 'Firewall' },
    { id: 'site-info-update.html',   icon: '🏢', name: 'Site-Info Update',   hint: 'Records',  crumb: 'Site-Info Update' },
    { id: 'server-automation-flow.html', icon: '▤', name: 'Server Automation Flow',   hint: 'Workflows',   crumb: 'Server Automation Flow' },
    { id: 'cloud-automation-flow.html',  icon: '◌', name: 'Cloud Automation Flow',    hint: 'Workflows',   crumb: 'Cloud Automation Flow' },
    { id: 'path-analysis-flow.html',     icon: '⟿', name: 'Path Analysis Flow',       hint: 'Diagnostics', crumb: 'Path Analysis Flow' },
    { id: 'circuit-diversity.html',      icon: '🔀', name: 'Circuit Diversity',        hint: 'Diagnostics', crumb: 'Circuit Diversity' },
    { id: 'request-incident-analysis.html', icon: '🧠', name: 'Request / Incident AI', hint: 'Assistant', crumb: 'Ticket AI' },
    { id: 'admin.html',              icon: '⚿', name: 'Admin Console',      hint: 'Admin',    crumb: 'Admin' }
  ];

  function isAdminSession() {
    try {
      return localStorage.getItem('currentUser') === 'Admin' && localStorage.getItem('isAdmin') === 'true';
    } catch (e) { return false; }
  }

  var ACTIONS = [
    { icon: '◐', name: 'Toggle light / dark theme', hint: 'Display', run: function () { toggleTheme(); } },
    { icon: '⎋', name: 'Sign out', hint: 'Session', run: function () {
        try {
          if (window.ActivityTracker && ActivityTracker.trackLogout) ActivityTracker.trackLogout();
          localStorage.removeItem('currentUser');
          localStorage.removeItem('isAdmin');
        } catch (e) {}
        go('index.html');
      } },
    { icon: '⌫', name: 'Clear site selection', hint: 'Session', run: function () {
        try {
          ['selectedRegion', 'selectedCountry', 'selectedSite', 'selectedSiteInfo']
            .forEach(function (k) { localStorage.removeItem(k); });
        } catch (e) {}
        toast('Site selection cleared');
        setTimeout(function () { location.reload(); }, 500);
      } }
  ];

  function here() {
    var f = decodeURIComponent(location.pathname.split('/').pop() || 'index.html');
    return ROUTES.filter(function (r) { return r.id === f; })[0];
  }

  function go(href) {
    if (REDUCED) { location.href = href; return; }
    var w = document.querySelector('.page-wipe');
    if (w) w.classList.add('on');
    setTimeout(function () { location.href = href; }, 240);
  }

  /* ── ambient light layers ─────────────────────────────────── */
  function ambience() {
    if (document.querySelector('.aurora')) return;
    var frag = document.createDocumentFragment();

    var a = document.createElement('div');
    a.className = 'aurora';
    a.innerHTML = '<i></i><i></i><i></i><i></i>';
    frag.appendChild(a);

    ['mesh', 'grain', 'vignette', 'page-wipe'].forEach(function (c) {
      var d = document.createElement('div');
      d.className = c;
      frag.appendChild(d);
    });

    document.body.insertBefore(frag, document.body.firstChild);
  }

  /* ── command bar ──────────────────────────────────────────── */
  function commandBar() {
    if (document.querySelector('.cmdbar')) return;
    if (document.body.hasAttribute('data-no-shell')) return;   // login screen

    var cur = here();
    var trail = '<a href="landing page.html">Home</a>';
    if (cur && cur.id !== 'landing page.html') {
      trail += '<span class="sep">/</span><b>' + cur.crumb + '</b>';
    } else {
      trail = '<b>Operations Home</b>';
    }

    var bar = document.createElement('header');
    bar.className = 'cmdbar';
    bar.innerHTML =
      '<span class="cmdbar-brand"><span class="cmdbar-mark"></span>Smart NetOps</span>' +
      '<span class="cmdbar-div"></span>' +
      '<nav class="crumbs">' + trail + '</nav>' +
      '<span class="cmdbar-spacer"></span>' +
      '<span class="cmd-stat hide-sm" id="shSite">No site selected</span>' +
      '<span class="cmdbar-div"></span>' +
      '<span class="cmd-stat"><span class="led" id="shLed"></span><span id="shLink">Online</span></span>' +
      '<span class="cmdbar-div"></span>' +
      '<span class="cmd-stat" id="shClock">--:--:--</span>' +
      '<button type="button" class="cmd-theme" id="shTheme" title="Toggle theme" aria-label="Toggle light and dark theme">◐</button>' +
      '<div class="cmd-trigger" id="shCmd">Search<kbd>⌘K</kbd></div>';

    document.body.insertBefore(bar, document.body.firstChild);
    document.body.classList.add('shell');
    if (isAdminSession()) {
      var siteEl = document.getElementById('shSite');
      if (siteEl) {
        var badge = document.createElement('button');
        badge.type = 'button';
        badge.className = 'cmd-theme';
        badge.title = 'Admin Console';
        badge.textContent = '⚿';
        badge.addEventListener('click', function () { go('admin.html'); });
        siteEl.parentNode.insertBefore(badge, document.getElementById('shTheme'));
      }
    }

    // breadcrumb links animate out like everything else
    bar.querySelectorAll('a').forEach(function (a) {
      a.addEventListener('click', function (e) {
        e.preventDefault();
        go(a.getAttribute('href'));
      });
    });

    // reflect the operator's current scope — read only
    try {
      var s = localStorage.getItem('selectedSite');
      var c = localStorage.getItem('selectedCountry');
      if (s) {
        document.getElementById('shSite').textContent =
          s + (c ? ' · ' + c : '');
      }
    } catch (e) {}

    function link() {
      var led = document.getElementById('shLed');
      var txt = document.getElementById('shLink');
      if (!led) return;
      led.className = navigator.onLine ? 'led' : 'led crit';
      txt.textContent = navigator.onLine ? 'Online' : 'Offline';
    }
    addEventListener('online', link);
    addEventListener('offline', link);
    link();

    function tick() {
      var el = document.getElementById('shClock');
      if (el) el.textContent = new Date().toISOString().slice(11, 19) + 'Z';
    }
    tick();
    setInterval(tick, 1000);

    document.getElementById('shCmd').addEventListener('click', openPalette);
    var themeBtn = document.getElementById('shTheme');
    if (themeBtn) {
      paintThemeButton(themeBtn);
      themeBtn.addEventListener('click', function () { toggleTheme(); });
    }
  }

  function currentTheme() {
    return document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
  }

  function paintThemeButton(btn) {
    if (!btn) btn = document.getElementById('shTheme');
    if (!btn) return;
    btn.textContent = currentTheme() === 'light' ? '☾' : '☀';
    btn.title = currentTheme() === 'light' ? 'Switch to dark theme' : 'Switch to light theme';
  }

  function toggleTheme() {
    var next = currentTheme() === 'light' ? 'dark' : 'light';
    document.documentElement.setAttribute('data-theme', next);
    try { localStorage.setItem('netops-theme', next); } catch (e) {}
    paintThemeButton();
    toast(next === 'light' ? 'Light theme on' : 'Dark theme on');
  }

  /* ── command palette ──────────────────────────────────────── */
  var pal, palInput, palList, palItems = [], palIdx = 0;

  function buildPalette() {
    if (pal) return;
    pal = document.createElement('div');
    pal.className = 'palette-scrim';
    pal.innerHTML =
      '<div class="palette" role="dialog" aria-label="Command palette">' +
        '<input type="text" placeholder="Jump to a module or run a command…" autocomplete="off">' +
        '<div class="palette-list"></div>' +
      '</div>';
    document.body.appendChild(pal);

    palInput = pal.querySelector('input');
    palList = pal.querySelector('.palette-list');

    pal.addEventListener('click', function (e) {
      if (e.target === pal) closePalette();
    });
    palInput.addEventListener('input', function () { render(palInput.value); });
    palInput.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowDown') { e.preventDefault(); move(1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); }
      else if (e.key === 'Enter') { e.preventDefault(); fire(palIdx); }
      else if (e.key === 'Escape') { closePalette(); }
    });
  }

  function candidates(q) {
    q = (q || '').toLowerCase().trim();
    var admin = isAdminSession();
    var all = ROUTES.filter(function (r) {
      return r.id !== 'admin.html' || admin;
    }).map(function (r) {
      return { icon: r.icon, name: r.name, hint: r.hint,
               run: function () { go(r.id); } };
    }).concat(ACTIONS.filter(function (a) { return !a.admin || admin; }));
    if (!q) return all;
    return all.filter(function (i) {
      return (i.name + ' ' + i.hint).toLowerCase().indexOf(q) > -1;
    });
  }

  function render(q) {
    palItems = candidates(q);
    palIdx = 0;
    if (!palItems.length) {
      palList.innerHTML = '<div class="palette-empty">Nothing matches that.</div>';
      return;
    }
    palList.innerHTML = palItems.map(function (i, n) {
      return '<div class="palette-item' + (n === 0 ? ' sel' : '') + '" data-n="' + n + '">' +
               '<span class="pi-icon">' + i.icon + '</span>' +
               '<span>' + i.name + '</span>' +
               '<span class="pi-hint">' + i.hint + '</span>' +
             '</div>';
    }).join('');
    palList.querySelectorAll('.palette-item').forEach(function (el) {
      el.addEventListener('click', function () { fire(+el.dataset.n); });
    });
  }

  function move(d) {
    var els = palList.querySelectorAll('.palette-item');
    if (!els.length) return;
    els[palIdx].classList.remove('sel');
    palIdx = (palIdx + d + els.length) % els.length;
    els[palIdx].classList.add('sel');
    els[palIdx].scrollIntoView({ block: 'nearest' });
  }

  function fire(n) {
    var item = palItems[n];
    if (!item) return;
    closePalette();
    item.run();
  }

  function openPalette() {
    buildPalette();
    render('');
    pal.classList.add('open');
    palInput.value = '';
    setTimeout(function () { palInput.focus(); }, 60);
  }

  function closePalette() {
    if (pal) pal.classList.remove('open');
  }

  /* ── toasts ───────────────────────────────────────────────── */
  function toast(msg, kind) {
    var host = document.querySelector('.toasts');
    if (!host) {
      host = document.createElement('div');
      host.className = 'toasts';
      document.body.appendChild(host);
    }
    var t = document.createElement('div');
    t.className = 'toast';
    t.innerHTML = '<span class="led ' + (kind || '') + '"></span><span>' + msg + '</span>';
    host.appendChild(t);
    setTimeout(function () {
      t.classList.add('out');
      setTimeout(function () { t.remove(); }, 320);
    }, 3200);
  }

  /* ── animated counters: [data-count="99.9"] ───────────────── */
  function counters() {
    document.querySelectorAll('[data-count]').forEach(function (el) {
      var target = parseFloat(el.dataset.count);
      if (isNaN(target)) return;
      var dec = (el.dataset.count.split('.')[1] || '').length;
      var pre = el.dataset.prefix || '';
      var suf = el.dataset.suffix || '';
      if (REDUCED) { el.textContent = pre + target.toFixed(dec) + suf; return; }

      var t0 = performance.now(), dur = 1400;
      (function step(now) {
        var p = Math.min((now - t0) / dur, 1);
        var e = 1 - Math.pow(1 - p, 4);                 // easeOutQuart
        el.textContent = pre + (target * e).toFixed(dec) + suf;
        if (p < 1) requestAnimationFrame(step);
      })(t0);
    });
  }

  /* ── spotlight, ripple, reveal ────────────────────────────── */
  function polish() {
    if (!REDUCED) {
      document.addEventListener('mousemove', function (e) {
        var el = e.target.closest && e.target.closest('.card,.stat-card,.panel');
        if (!el) return;
        var r = el.getBoundingClientRect();
        el.style.setProperty('--mx', (e.clientX - r.left) + 'px');
        el.style.setProperty('--my', (e.clientY - r.top) + 'px');
      }, { passive: true });

      document.addEventListener('pointerdown', function (e) {
        var b = e.target.closest && e.target.closest('button,.btn,.dropdown-btn,.action-btn');
        if (!b) return;
        var r = b.getBoundingClientRect();
        var s = document.createElement('span');
        s.className = 'ripple';
        s.style.left = (e.clientX - r.left) + 'px';
        s.style.top = (e.clientY - r.top) + 'px';
        b.appendChild(s);
        setTimeout(function () { s.remove(); }, 620);
      }, { passive: true });
    }

    if ('IntersectionObserver' in window) {
      var io = new IntersectionObserver(function (es) {
        es.forEach(function (en) {
          if (!en.isIntersecting) return;
          en.target.classList.add('in');
          io.unobserve(en.target);
        });
      }, { threshold: 0.06, rootMargin: '0px 0px -40px' });
      document.querySelectorAll('.reveal').forEach(function (el) { io.observe(el); });
    } else {
      document.querySelectorAll('.reveal').forEach(function (el) { el.classList.add('in'); });
    }
  }

  /* ── keys ─────────────────────────────────────────────────── */
  function keys() {
    addEventListener('keydown', function (e) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        pal && pal.classList.contains('open') ? closePalette() : openPalette();
      }
      if (e.key === 'Escape') closePalette();
    });
  }

  function loginThemeToggle() {
    if (!document.body || !document.body.hasAttribute('data-no-shell')) return;
    if (document.getElementById('shTheme')) return;
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'cmd-theme login-theme';
    b.id = 'shTheme';
    b.setAttribute('aria-label', 'Toggle light and dark theme');
    paintThemeButton(b);
    b.addEventListener('click', function () { toggleTheme(); });
    document.body.appendChild(b);
  }

  function init() {
    try { ambience(); }   catch (e) {}
    try { commandBar(); } catch (e) {}
    try { loginThemeToggle(); } catch (e) {}
    try { keys(); }       catch (e) {}
    try { polish(); }     catch (e) {}
    try { counters(); }   catch (e) {}
  }

  // exposed so pages can use them
  window.NetOps = { toast: toast, go: go, palette: openPalette, counters: counters, toggleTheme: toggleTheme };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
