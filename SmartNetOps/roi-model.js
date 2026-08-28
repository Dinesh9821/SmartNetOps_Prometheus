(function () {
  'use strict';

  /**
   * Modeled annual value by module. These are executive planning figures
   * (hours avoided × loaded cost, plus outage-avoidance), not Prometheus
   * scrapes. Live usage from ActivityTracker scales realized value.
   */
  var MODULES = [
    { id: 'Monitoring', page: 'monitoring.html', annual: 620000, hours: 2600, lever: 'MTTD / MTTR on WAN and SD-WAN' },
    { id: 'Dashboard', page: 'dashboard.html', annual: 240000, hours: 900, lever: 'Fleet health in one pane; fewer war-room hours' },
    { id: 'ChatOps', page: 'chatops.html', annual: 310000, hours: 1400, lever: 'Conversational ops instead of ticket ping-pong' },
    { id: 'Network with Us', page: 'netchatops.html', annual: 190000, hours: 720, lever: 'Site assistant reduces specialist queue time' },
    { id: 'NetAutomation Flow', page: 'Netautomation Flow.html', annual: 480000, hours: 1800, lever: 'Repeatable change without weekend change windows' },
    { id: 'Network Diagram', page: 'Network Diagram.html', annual: 95000, hours: 380, lever: 'Instant topology for incidents and audits' },
    { id: 'Logic Monitor Operations', page: 'logicmonitor.html', annual: 270000, hours: 1100, lever: 'Maintenance windows without alert storms' },
    { id: 'Path Analysis Flow', page: 'path-analysis-flow.html', annual: 185000, hours: 640, lever: 'Hop-by-hop proof instead of multi-team traceroute' },
    { id: 'Firewall', page: 'firewall.html', annual: 410000, hours: 1500, lever: 'Faster rule review; fewer blocked-business tickets' },
    { id: 'Site-Info Update', page: 'site-info-update.html', annual: 72000, hours: 280, lever: 'Clean CMDB; fewer truck rolls to the wrong site' },
    { id: 'Circuit Diversity', page: 'circuit-diversity.html', annual: 340000, hours: 420, lever: 'Prove diverse paths before the dual-cut incident' },
    { id: 'Server Automation Flow', page: 'server-automation-flow.html', annual: 265000, hours: 980, lever: 'Standard server build and patch cadence' },
    { id: 'Cloud Automation Flow', page: 'cloud-automation-flow.html', annual: 255000, hours: 940, lever: 'Cloud drift caught before the invoice' },
    { id: 'Request / Incident AI', page: 'request-incident-analysis.html', annual: 155000, hours: 520, lever: 'Ticket summarization before the bridge call' },
    { id: 'Admin Console', page: 'admin.html', annual: 48000, hours: 160, lever: 'Usage and ROI visibility for the operating model' }
  ];

  var ALIASES = {
    'Logic Monitor': 'Logic Monitor Operations',
    "Network's Vedas": 'Network with Us',
    'Network with us': 'Network with Us',
    'Request/Incident AI analysis': 'Request / Incident AI',
    'Request-Incident-Analysis': 'Request / Incident AI'
  };

  var HOURLY = 185;

  function fileOf(path) {
    return String(path || '').split('/').pop() || '';
  }

  function moduleOfLog(log) {
    if (log.module) {
      var name = ALIASES[log.module] || log.module;
      var hit = MODULES.filter(function (m) {
        return m.id.toLowerCase() === String(name).toLowerCase();
      })[0];
      if (hit) return hit.id;
    }
    var f = fileOf(log.page);
    var byPage = MODULES.filter(function (m) { return m.page === f; })[0];
    return byPage ? byPage.id : null;
  }

  function usageWeight(accesses) {
    return 0.55 + 0.45 * Math.min(1, (accesses || 0) / 24);
  }

  function summarize(logs) {
    logs = logs || [];
    var byMod = {};
    MODULES.forEach(function (m) {
      byMod[m.id] = { accesses: 0, tasks: 0, users: {}, sites: {}, last: null };
    });
    var users = {};
    var userEvents = {};
    var sites = {};
    var logins = 0;
    var days = {};

    logs.forEach(function (l) {
      var u = l.username || 'Unknown';
      users[u] = true;
      if (!userEvents[u]) userEvents[u] = { events: 0, last: null, modules: {} };
      userEvents[u].events += 1;
      if (!userEvents[u].last || l.timestamp > userEvents[u].last) userEvents[u].last = l.timestamp;
      if (l.site) sites[l.site] = true;
      if (l.type === 'login') logins += 1;
      if (l.timestamp) days[String(l.timestamp).slice(0, 10)] = true;
      var mid = moduleOfLog(l);
      if (!mid || !byMod[mid]) return;
      userEvents[u].modules[mid] = true;
      var rec = byMod[mid];
      if (l.type === 'module_access' || l.type === 'page_view' || l.type === 'task') rec.accesses += 1;
      if (l.type === 'task') rec.tasks += 1;
      rec.users[u] = true;
      if (l.site) rec.sites[l.site] = true;
      if (!rec.last || l.timestamp > rec.last) rec.last = l.timestamp;
    });

    var rows = MODULES.map(function (m) {
      var rec = byMod[m.id];
      var accesses = rec.accesses;
      var realized = Math.round(m.annual * usageWeight(accesses));
      return {
        id: m.id,
        page: m.page,
        lever: m.lever,
        annual: m.annual,
        hours: m.hours,
        hourly: HOURLY,
        accesses: accesses,
        tasks: rec.tasks,
        operators: Object.keys(rec.users).length,
        sites: Object.keys(rec.sites).length,
        last: rec.last,
        realized: realized,
        adoption: Math.round(100 * usageWeight(accesses)),
        hoursRecovered: Math.round(realized / HOURLY)
      };
    });

    var modeled = rows.reduce(function (a, r) { return a + r.annual; }, 0);
    var realized = rows.reduce(function (a, r) { return a + r.realized; }, 0);
    var hoursRecovered = Math.round(realized / HOURLY);

    var dayKeys = [];
    var cursor = new Date();
    for (var i = 13; i >= 0; i--) {
      var d = new Date(cursor);
      d.setDate(d.getDate() - i);
      dayKeys.push(d.toISOString().slice(0, 10));
    }
    var byDay = {};
    dayKeys.forEach(function (k) { byDay[k] = 0; });
    logs.forEach(function (l) {
      var k = l.timestamp ? String(l.timestamp).slice(0, 10) : '';
      if (Object.prototype.hasOwnProperty.call(byDay, k)) byDay[k] += 1;
    });

    var operators = Object.keys(userEvents).map(function (name) {
      return {
        username: name,
        events: userEvents[name].events,
        last: userEvents[name].last,
        modules: Object.keys(userEvents[name].modules).length
      };
    }).sort(function (a, b) { return b.events - a.events; });

    return {
      hourly: HOURLY,
      modeled: modeled,
      realized: realized,
      coverage: modeled ? Math.round(100 * realized / modeled) : 0,
      hoursRecovered: hoursRecovered,
      uniqueUsers: Object.keys(users).length,
      logins: logins,
      sitesTouched: Object.keys(sites).length,
      activeDays: Object.keys(days).length,
      events: logs.length,
      rows: rows,
      operators: operators,
      spark: dayKeys.map(function (k) { return { day: k, n: byDay[k] }; })
    };
  }

  window.NetOpsROI = { MODULES: MODULES, HOURLY: HOURLY, summarize: summarize, usageWeight: usageWeight };
})();
