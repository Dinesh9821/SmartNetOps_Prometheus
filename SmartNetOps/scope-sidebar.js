(function (global) {
  "use strict";

  var DASH_MODE_KEY = "dashboardMode";
  var DASH_REGION_KEY = "dashboardSelectedRegion";
  var DASH_COUNTRY_KEY = "dashboardSelectedCountry";
  var DASH_SITE_KEY = "dashboardSelectedSite";
  var DASH_SITE_INFO_KEY = "dashboardSelectedSiteInfo";
  var SITE_LIST_CACHE_KEY = "netops_site_lists";

  function proxyOrigin() {
    try {
      if (location.protocol === "http:" || location.protocol === "https:") {
        if (location.port === "8080") return "";
        return location.protocol + "//" + location.hostname + ":8080";
      }
    } catch (e) {}
    return "http://cussya5w.carcgl.com:8080";
  }

  var COUNTRY_SITES_API = proxyOrigin() + "/proxy1";

  var regionData = {
    APAC: {
      "China": ["CHN-BJS-DC-001"], "Japan": ["JPN-TYO-DC-002"], "Korea, Republic of": [],
      "Taiwan": ["TWN-TPE-DC-006"], "Malaysia": ["MYS-KUL-DC-008"], "Singapore": ["SGP-SGP-DC-009"],
      "Thailand": ["THA-BKK-DC-010"], "Vietnam": ["VNM-HAN-DC-012"], "Brunei Darussalam": ["BRN-BWN-DC-016"],
      "India": ["IND-MUM-DC-018"], "Australia": ["AUS-SYD-DC-026"], "Guam": [], "Hong Kong": [], "Macau": [], "New Zealand": []
    },
    EMEA: {
      "United Kingdom": ["London-45", "Manchester-12"], "Germany": ["Berlin-7", "Munich-10"],
      "Italy": ["Rome-2", "Milan-6"], "Czech Republic": [], "Spain": ["ESP-MAD-DC-001"],
      "South Africa": ["ZAF-JHB-BR-014"], "Saudi Arabia": ["KSA-RYD-DC-004"], "UAE": ["UAE-DXB-POP-005"],
      "Austria": ["AUT-VIE-DC-001"], "Belgium": ["BEL-BRU-DC-002"], "Netherlands": ["NLD-AMS-DC-003"],
      "Poland": ["POL-WAW-DC-004"], "Sweden": ["SWE-STO-DC-005"], "Turkey": ["TUR-IST-DC-015"],
      "Bulgaria": [], "Switzerland": [], "Denmark": [], "Finland": [], "Greece": [], "France": [],
      "Croatia": [], "Hungary": [], "Ireland": [], "Kuwait": [], "Lithuania": [], "Luxembourg": [],
      "Latvia": [], "Norway": [], "Portugal": [], "Romania": [], "Serbia": [], "Russian Federation": [],
      "Slovenia": [], "Slovakia": [], "Ukraine": []
    },
    AMER: {
      "Canada": ["CAN-TOR-DC-001"], "United States": ["USA-NYC-DC-002"],
      "United States of America": ["USA-NV-LAS-001"], "Mexico": ["MEX-MEX-DC-003"],
      "Argentina": ["ARG-BUE-DC-024"], "Brazil": ["BRA-GRU-DC-026"]
    }
  };

  var regionPanel;
  var countryPanel;
  var sitePanel;

  function currentMode() {
    return localStorage.getItem(DASH_MODE_KEY) === "site" ? "site" : "global";
  }
  function extractSiteId(raw) {
    if (!raw) return "";
    return String(raw).split("|")[0].trim();
  }
  function domainName() {
    return document.body.getAttribute("data-scope-domain") || "Operations";
  }
  function applyScopeCopy() {
    var mode = currentMode();
    var site = extractSiteId(localStorage.getItem(DASH_SITE_KEY));
    var domain = domainName();
    var eyebrow = document.getElementById("scopeEyebrow");
    var sub = document.getElementById("scopeSub");
    if (mode === "site") {
      if (eyebrow) eyebrow.textContent = "Site view / " + domain;
      if (sub) {
        sub.textContent = site
          ? domain + " information for site " + site + "."
          : "Site specific — select a Site ID.";
      }
    } else {
      if (eyebrow) eyebrow.textContent = "Global view / " + domain;
      if (sub) sub.textContent = "Whole-globe " + domain.toLowerCase() + " information.";
    }
    if (typeof global.onGlobalScopeChange === "function") {
      global.onGlobalScopeChange(mode, site || "");
    }
  }
  function closeScopeDropdowns() {
    ["regionPanel", "countryPanel", "sitePanel", "rangePanel"].forEach(function (id) {
      var el = document.getElementById(id);
      if (el) el.style.display = "none";
    });
  }
  function paintModeButtons(mode, sitePanelOpen) {
    var globalBtn = document.getElementById("globalBtn");
    var siteBtn = document.getElementById("siteBtn");
    if (globalBtn) {
      globalBtn.style.background = mode === "global" ? "rgba(255,255,255,0.26)" : "rgba(255,255,255,0.18)";
    }
    if (siteBtn) {
      siteBtn.style.background = sitePanelOpen ? "rgba(255,255,255,0.26)" : "rgba(255,255,255,0.18)";
    }
  }
  function selectMode(mode, opts) {
    opts = opts || {};
    var panel = document.getElementById("siteSpecificPanel");
    if (mode === "global") {
      localStorage.setItem(DASH_MODE_KEY, "global");
      if (panel) panel.style.display = "none";
      closeScopeDropdowns();
      paintModeButtons("global", false);
      if (!opts.skipLoad) applyScopeCopy();
      return;
    }
    localStorage.setItem(DASH_MODE_KEY, "site");
    if (panel) panel.style.display = "block";
    paintModeButtons("site", true);
    if (!opts.skipLoad) applyScopeCopy();
  }
  function toggleSiteSpecific() {
    var panel = document.getElementById("siteSpecificPanel");
    if (!panel) return;
    var isOpen = panel.style.display === "block";
    if (isOpen) {
      panel.style.display = "none";
      closeScopeDropdowns();
      paintModeButtons(currentMode(), false);
      return;
    }
    selectMode("site");
  }
  function togglePanel(panelId) {
    var p = document.getElementById(panelId);
    if (!p) return;
    var map = {
      regionPanel: "regionBtn",
      countryPanel: "countryBtn",
      sitePanel: "siteBtnSelect",
      rangePanel: "rangeBtn"
    };
    var control = document.getElementById(map[panelId]);
    if (control && control.disabled) return;
    var open = p.style.display === "block";
    closeScopeDropdowns();
    p.style.display = open ? "none" : "block";
  }
  function updatePickerAvailability() {
    var countryBtn = document.getElementById("countryBtn");
    var siteBtnSelect = document.getElementById("siteBtnSelect");
    if (countryBtn) countryBtn.disabled = !localStorage.getItem(DASH_REGION_KEY);
    if (siteBtnSelect) {
      siteBtnSelect.disabled = !(
        localStorage.getItem(DASH_REGION_KEY) && localStorage.getItem(DASH_COUNTRY_KEY)
      );
    }
  }
  function siteCacheKey(region, country) { return region + "::" + country; }
  function readSiteListCache() {
    try {
      var cache = JSON.parse(sessionStorage.getItem(SITE_LIST_CACHE_KEY) || "{}");
      return cache && typeof cache === "object" && !Array.isArray(cache) ? cache : {};
    } catch (e) { return {}; }
  }
  function writeSiteListCache(region, country, sites) {
    try {
      var cache = readSiteListCache();
      cache[siteCacheKey(region, country)] = sites;
      sessionStorage.setItem(SITE_LIST_CACHE_KEY, JSON.stringify(cache));
    } catch (e) {}
  }
  function normalizeSiteLabel(s) {
    if (typeof s === "string") return s.trim();
    if (typeof s === "object" && s) {
      var parts = [s.U_SITE_ID, s.U_STREET_ADDRESS, s.U_CITY, s.U_STATE, s.U_COUNTRY, s.U_PINCODE]
        .filter(function (val) { return val && String(val).trim() !== ""; });
      return parts.length ? parts.join(" | ") : "";
    }
    return String(s).trim();
  }
  function populateRegions() {
    if (!regionPanel) return;
    Object.keys(regionData).forEach(function (r) {
      var el = document.createElement("div");
      el.className = "dropdown-item";
      el.textContent = r;
      el.onclick = function () { selectRegion(r); };
      regionPanel.appendChild(el);
    });
  }
  function loadCountries(region) {
    if (!countryPanel || !sitePanel) return;
    countryPanel.innerHTML = '<div class="search-group"><input type="text" id="countrySearch" placeholder="Search Country" oninput="filterDropdown(\'country\')"></div>';
    sitePanel.innerHTML = '<div class="search-group"><input type="text" id="siteSearch" placeholder="Search Site" oninput="filterDropdown(\'site\')"></div>';
    Object.keys(regionData[region] || {}).forEach(function (c) {
      var el = document.createElement("div");
      el.className = "dropdown-item";
      el.textContent = c;
      el.onclick = function () { selectCountry(region, c); };
      countryPanel.appendChild(el);
    });
  }
  function loadSites(region, country) {
    if (!sitePanel) return;
    sitePanel.innerHTML = '<div class="search-group"><input type="text" id="siteSearch" placeholder="Search Site" oninput="filterDropdown(\'site\')"></div>';
    (regionData[region][country] || []).forEach(function (s) {
      var el = document.createElement("div");
      el.className = "dropdown-item";
      el.textContent = s;
      el.onclick = function () { selectSite(s); };
      sitePanel.appendChild(el);
    });
  }
  function selectRegion(region) {
    document.getElementById("regionBtn").textContent = "🌐 Region: " + region;
    document.getElementById("regionPanel").style.display = "none";
    document.getElementById("countryBtn").textContent = "📡 Country";
    document.getElementById("siteBtnSelect").textContent = "🛠 Site ID";
    localStorage.setItem(DASH_REGION_KEY, region);
    localStorage.removeItem(DASH_COUNTRY_KEY);
    localStorage.removeItem(DASH_SITE_KEY);
    localStorage.removeItem(DASH_SITE_INFO_KEY);
    updatePickerAvailability();
    loadCountries(region);
    applyScopeCopy();
  }
  async function fetchSitesForCountry(region, country) {
    var sitePanelEl = document.getElementById("sitePanel");
    if (sitePanelEl) {
      sitePanelEl.innerHTML = '<div class="search-group"><input type="text" id="siteSearch" placeholder="Search Site" oninput="filterDropdown(\'site\')"></div><div class="dropdown-item">Loading sites for ' + country + "...</div>";
    }
    var cachedSites = readSiteListCache()[siteCacheKey(region, country)];
    if (Array.isArray(cachedSites) && cachedSites.length) {
      regionData[region][country] = cachedSites;
      loadSites(region, country);
      if (sitePanelEl) sitePanelEl.style.display = "block";
      return;
    }
    try {
      var res = await fetch(COUNTRY_SITES_API, {
        method: "POST",
        mode: "cors",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ region: region, country: country })
      });
      var text = await res.text();
      var data = null;
      try { data = JSON.parse(text); } catch (e) {}
      var sites = [];
      if (Array.isArray(data)) sites = data;
      else if (Array.isArray(data && data.sites)) sites = data.sites;
      else if (Array.isArray(data && data.data)) sites = data.data;
      else if (Array.isArray(data && data.result)) sites = data.result;
      else if (data && typeof data === "object") {
        var vals = Object.values(data).flat();
        if (Array.isArray(vals)) sites = vals;
      }
      var normalized = sites.map(normalizeSiteLabel).filter(Boolean);
      var sortedSites = Array.from(new Set(normalized)).sort(function (a, b) {
        return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
      });
      if (!sortedSites.length) throw new Error("API returned no usable site IDs");
      regionData[region][country] = sortedSites;
      writeSiteListCache(region, country, sortedSites);
      loadSites(region, country);
      if (sitePanelEl) sitePanelEl.style.display = "block";
    } catch (err) {
      if (sitePanelEl) {
        sitePanelEl.innerHTML = '<div class="search-group"><input type="text" id="siteSearch" placeholder="Search Site" oninput="filterDropdown(\'site\')"></div><div class="dropdown-item" style="color:#ffb3b3;">Error loading sites: ' + err.message + "</div>";
      }
      if (regionData[region] && regionData[region][country] && regionData[region][country].length) {
        loadSites(region, country);
        if (sitePanelEl) sitePanelEl.style.display = "block";
      }
    }
  }
  async function selectCountry(region, country) {
    document.getElementById("countryBtn").textContent = "📡 Country: " + country;
    document.getElementById("countryPanel").style.display = "none";
    document.getElementById("siteBtnSelect").textContent = "🛠 Site ID";
    localStorage.setItem(DASH_COUNTRY_KEY, country);
    localStorage.removeItem(DASH_SITE_KEY);
    localStorage.removeItem(DASH_SITE_INFO_KEY);
    updatePickerAvailability();
    await fetchSitesForCountry(region, country);
  }
  function selectSite(site) {
    document.getElementById("siteBtnSelect").textContent = "🛠 Site: " + site;
    document.getElementById("sitePanel").style.display = "none";
    localStorage.setItem(DASH_MODE_KEY, "site");
    localStorage.setItem(DASH_SITE_KEY, site);
    updatePickerAvailability();
    paintModeButtons("site", true);
    applyScopeCopy();
  }
  function filterDropdown(kind) {
    var input;
    var panel;
    if (kind === "region") { input = document.getElementById("regionSearch"); panel = regionPanel; }
    else if (kind === "country") { input = document.getElementById("countrySearch"); panel = countryPanel; }
    else { input = document.getElementById("siteSearch"); panel = sitePanel; }
    if (!input || !panel) return;
    var filter = input.value.toLowerCase();
    Array.from(panel.getElementsByClassName("dropdown-item")).forEach(function (it) {
      it.style.display = it.textContent.toLowerCase().includes(filter) ? "" : "none";
    });
  }
  async function restoreSiteSelection() {
    var savedRegion = localStorage.getItem(DASH_REGION_KEY);
    var savedCountry = localStorage.getItem(DASH_COUNTRY_KEY);
    var savedSite = localStorage.getItem(DASH_SITE_KEY);
    if (savedRegion && regionData[savedRegion]) {
      document.getElementById("regionBtn").textContent = "🌐 Region: " + savedRegion;
      loadCountries(savedRegion);
    }
    if (savedCountry && savedRegion) {
      document.getElementById("countryBtn").textContent = "📡 Country: " + savedCountry;
      await fetchSitesForCountry(savedRegion, savedCountry);
    }
    if (savedSite) document.getElementById("siteBtnSelect").textContent = "🛠 Site: " + savedSite;
    updatePickerAvailability();
    closeScopeDropdowns();
  }

  function bootScopeSidebar() {
    regionPanel = document.getElementById("regionPanel");
    countryPanel = document.getElementById("countryPanel");
    sitePanel = document.getElementById("sitePanel");
    populateRegions();
    restoreSiteSelection().then(function () {
      if (currentMode() === "site") selectMode("site");
      else selectMode("global");
    });
  }

  global.selectMode = selectMode;
  global.toggleSiteSpecific = toggleSiteSpecific;
  global.togglePanel = togglePanel;
  global.filterDropdown = filterDropdown;
  global.currentScopeMode = currentMode;
  global.currentScopeSiteId = function () {
    return extractSiteId(localStorage.getItem(DASH_SITE_KEY));
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", bootScopeSidebar);
  } else {
    bootScopeSidebar();
  }
})(window);
