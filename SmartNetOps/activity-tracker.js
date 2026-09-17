(function () {
  'use strict';

  const STORAGE_KEY = 'netops_activity_logs';
  const MAX_LOGS = 1000;

  function safeParse(value, fallback) {
    try { return JSON.parse(value); } catch { return fallback; }
  }

  function getLogs() {
  console.log(STORAGE_KEY);

    return safeParse(localStorage.getItem(STORAGE_KEY), []);
  }

  function setLogs(logs) {
  console.log(STORAGE_KEY);
  console.log(logs);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(logs.slice(-MAX_LOGS)));
  }

  function nowIso() {
    return new Date().toISOString();
  }

  function getSelections() {
    return {
      region: localStorage.getItem('selectedRegion') || null,
      country: localStorage.getItem('selectedCountry') || null,
      site: localStorage.getItem('selectedSite') || null,
    };
  }

  function addLog(entry) {
    const logs = getLogs();
    if(logs){
    console.log(logs);
    logs.push({
      timestamp: nowIso(),
      ...entry,
    });
    setLogs(logs);
    }

  }

  function trackLogin(username, isAdmin = false) {
    localStorage.setItem('currentUser', username);
    localStorage.setItem('isAdmin', isAdmin ? 'true' : 'false');
    addLog({ type: 'login', username, isAdmin, page: location.pathname });
  }

  function trackRegionSelection(region) {
    addLog({ type: 'region_selection', username: localStorage.getItem('currentUser') || 'Unknown', region, page: location.pathname });
  }

  function trackCountrySelection(country, region) {
    addLog({ type: 'country_selection', username: localStorage.getItem('currentUser') || 'Unknown', country, region, page: location.pathname });
  }

  function trackSiteSelection(site, region, country) {
    addLog({ type: 'site_selection', username: localStorage.getItem('currentUser') || 'Unknown', site, region, country, page: location.pathname });
  }

  function trackModuleAccess(module) {
    const sel = getSelections();
    addLog({ type: 'module_access', username: localStorage.getItem('currentUser') || 'Unknown', module, ...sel, page: location.pathname });
  }

  function trackTask(module, task, details = {}) {
    const sel = getSelections();
    addLog({ type: 'task', username: localStorage.getItem('currentUser') || 'Unknown', module, task, taskDetails: details, ...sel, page: location.pathname });
  }

  function trackPageView() {
    const user = localStorage.getItem('currentUser') || 'Unknown';
    addLog({ type: 'page_view', username: user, page: location.pathname });
  }

  function clearLogs() {
    localStorage.removeItem(STORAGE_KEY);
  }

  window.ActivityTracker = {
    trackLogin,
    trackRegionSelection,
    trackCountrySelection,
    trackSiteSelection,
    trackModuleAccess,
    trackTask,
    trackPageView,
    getAllLogs: getLogs,
    clearLogs,
    getSelections,
  };

  window.addEventListener('load', trackPageView);
})();


