const STORAGE_KEY = 'wifiwatch_user_data';
const DEFAULT_DATA = {
  schemaVersion: 1,
  settings: { monthlyLimitGB: 1000, cycleStartDay: 1, isUnlimited: true, detectedModel: 'MTN 5G ODU • ZLT X17U' },
  sources: [],
  records: [],
  recordVariants: [],
  observations: [],
  events: [],
  accounting: {},
  lastSync: null
};

let chartInstance = null;
let currentData = JSON.parse(JSON.stringify(DEFAULT_DATA));
let selectedMonthKey = null;
let currentPage = 1;
const PAGE_SIZE = 10;
let dashboardPollTimer = null;
let startupCollectorAttempted = false;
let serviceConfig = null;
let serviceAuthority = /^(localhost|127\.0\.0\.1)$/.test(window.location.hostname)
  ? 'local-service'
  : 'browser';
let activeChartRange = 'all';
let isPrivacyOn = localStorage.getItem('wifiwatch_privacy') === 'true';

// Request notification permission if available
if ('Notification' in window && Notification.permission === 'default') {
  Notification.requestPermission();
}

function loadLocalData() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && (Array.isArray(parsed.records) || Array.isArray(parsed.recordVariants))) {
        return parsed;
      }
    }
  } catch (e) {
    console.error('Error reading localStorage:', e);
  }
  return null;
}

function saveLocalData(data) {
  currentData = data;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  } catch (e) {
    console.error('Error saving to localStorage:', e);
  }
}

// Merge records without data loss across resets
function mergeRecords(newRecords, detectedModel = null) {
  const map = new Map();
  if (detectedModel) {
    currentData.settings.detectedModel = detectedModel;
  }
  (currentData.records || []).forEach(r => map.set(r.date, r));
  (newRecords || []).forEach(nr => {
    if (!map.has(nr.date) || nr.isCorrected || !map.get(nr.date).isCorrected) {
      map.set(nr.date, nr);
    }
  });
  currentData.records = Array.from(map.values()).map(r => {
    if (r.usageGB > 500) {
      const fixedGB = parseFloat((r.usageGB / 1024).toFixed(2));
      return { ...r, usageGB: fixedGB, usageBytes: Math.round(fixedGB * 1024 * 1024 * 1024) };
    }
    return r;
  }).sort((a, b) => a.date.localeCompare(b.date));
  saveLocalData(currentData);
  renderMonthSelector();
  renderDashboard();
}

// Intelligent state application that protects existing local history
function applyDashboardState(nextData) {
  if (!nextData || (!Array.isArray(nextData.records) && !Array.isArray(nextData.recordVariants))) return false;

  const map = new Map();
  (currentData.records || []).forEach(r => map.set(r.date, r));

  const incoming = Array.isArray(nextData.recordVariants) && nextData.recordVariants.length > 0
    ? nextData.recordVariants
    : (nextData.records || []);

  incoming.forEach(nr => {
    if (!map.has(nr.date) || nr.isCorrected || !map.get(nr.date).isCorrected) {
      map.set(nr.date, nr);
    }
  });

  const mergedRecords = Array.from(map.values()).map(r => {
    if (r.usageGB > 500) {
      const fixedGB = parseFloat((r.usageGB / 1024).toFixed(2));
      return { ...r, usageGB: fixedGB, usageBytes: Math.round(fixedGB * 1024 * 1024 * 1024) };
    }
    return r;
  }).sort((a, b) => a.date.localeCompare(b.date));

  currentData = {
    ...JSON.parse(JSON.stringify(DEFAULT_DATA)),
    ...currentData,
    ...nextData,
    records: mergedRecords,
    settings: {
      ...DEFAULT_DATA.settings,
      ...(currentData.settings || {}),
      ...(nextData.settings || {})
    }
  };

  saveLocalData(currentData);
  renderMonthSelector();
  renderDashboard();
  return true;
}

// Detect untracked/missing calendar days in the selected month
function detectGaps(records, monthKey) {
  if (!monthKey) return [];
  const [yearStr, monthStr] = monthKey.split('-');
  const year = parseInt(yearStr, 10);
  const month = parseInt(monthStr, 10);
  const daysInMonth = new Date(year, month, 0).getDate();

  const now = new Date();
  const currentMonthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const isCurrentMonth = monthKey === currentMonthKey;

  if (monthKey > currentMonthKey) return [];

  const maxDayToCheck = isCurrentMonth ? Math.min(daysInMonth, now.getDate()) : daysInMonth;
  const monthRecords = (records || []).filter(r => r.date && r.date.startsWith(monthKey));
  const existingDates = new Set(monthRecords.map(r => r.date));

  const gaps = [];
  for (let day = 1; day <= maxDayToCheck; day++) {
    const dayStr = String(day).padStart(2, '0');
    const fullDate = `${yearStr}-${monthStr}-${dayStr}`;
    if (!existingDates.has(fullDate)) {
      gaps.push(fullDate);
    }
  }
  return gaps;
}

// Render the Fix Gaps modal
function renderGapsModal() {
  const gaps = detectGaps(currentData.records || [], selectedMonthKey);
  const container = document.getElementById('gaps-list-container');
  const descEl = document.getElementById('gaps-modal-desc');
  const msgEl = document.getElementById('gaps-status-msg');
  if (msgEl) msgEl.textContent = '';
  if (!container) return;

  if (gaps.length === 0) {
    if (descEl) descEl.textContent = 'No missing days detected in this period! All records are continuous.';
    container.innerHTML = `<div style="text-align: center; color: var(--text-muted); padding: 18px; font-size: 0.85rem;">All daily records in this billing period are logged.</div>`;
    return;
  }

  if (descEl) descEl.textContent = `Found ${gaps.length} untracked calendar day(s) in ${selectedMonthKey}:`;
  container.innerHTML = gaps.map(date => `
    <div class="gap-item">
      <span class="gap-date">${date}</span>
      <div class="gap-actions-row">
        <button type="button" class="btn btn-outline btn-xs" onclick="window.fillSingleGap('${date}', 0)">0 GB (Off)</button>
        <button type="button" class="btn btn-secondary btn-xs" onclick="window.promptFillGap('${date}')">Custom</button>
      </div>
    </div>
  `).join('');
}

// Gap Fill Helpers
window.fillSingleGap = function(date, gbValue) {
  const usageGB = Math.max(0, parseFloat(gbValue) || 0);
  const newRecord = {
    date,
    usageGB,
    usageBytes: Math.round(usageGB * 1024 * 1024 * 1024),
    downloadBytes: null,
    uploadBytes: null,
    isCorrected: false,
    sourceId: 'gap-fill',
    sourceType: usageGB === 0 ? 'manual' : 'estimated',
    sourceLabel: usageGB === 0 ? 'Offline / 0 GB' : 'Estimated',
    confidence: 'observed',
    granularity: 'day',
    observedAt: new Date().toISOString(),
    rawMessage: `Gap filled: ${usageGB.toFixed(2)} GB`
  };
  mergeRecords([newRecord]);
  renderGapsModal();
};

window.promptFillGap = function(date) {
  const val = prompt(`Enter data used in GB for ${date}:`, '0.00');
  if (val !== null && val.trim() !== '') {
    window.fillSingleGap(date, val);
  }
};

function fillGapsWithZero() {
  const gaps = detectGaps(currentData.records || [], selectedMonthKey);
  if (gaps.length === 0) return;
  const newRecords = gaps.map(date => ({
    date,
    usageGB: 0,
    usageBytes: 0,
    downloadBytes: null,
    uploadBytes: null,
    isCorrected: false,
    sourceId: 'gap-fill-zero',
    sourceType: 'manual',
    sourceLabel: 'Offline / 0 GB',
    confidence: 'observed',
    granularity: 'day',
    observedAt: new Date().toISOString(),
    rawMessage: 'Gap filled: 0.00 GB (Offline)'
  }));
  mergeRecords(newRecords);
  renderGapsModal();
  const msgEl = document.getElementById('gaps-status-msg');
  if (msgEl) {
    msgEl.className = 'status-msg success';
    msgEl.textContent = `Filled ${newRecords.length} missing days as 0.00 GB.`;
  }
}

function fillGapsWithAvg() {
  const gaps = detectGaps(currentData.records || [], selectedMonthKey);
  if (gaps.length === 0) return;

  const monthRecords = (currentData.records || []).filter(r => r.date.startsWith(selectedMonthKey));
  const totalGB = monthRecords.reduce((sum, r) => sum + r.usageGB, 0);
  const avgGB = monthRecords.length > 0 ? parseFloat((totalGB / monthRecords.length).toFixed(2)) : 0;

  const newRecords = gaps.map(date => ({
    date,
    usageGB: avgGB,
    usageBytes: Math.round(avgGB * 1024 * 1024 * 1024),
    downloadBytes: null,
    uploadBytes: null,
    isCorrected: false,
    sourceId: 'gap-fill-avg',
    sourceType: 'estimated',
    sourceLabel: 'Estimated Daily Avg',
    confidence: 'observed',
    granularity: 'day',
    observedAt: new Date().toISOString(),
    rawMessage: `Gap filled: ${avgGB.toFixed(2)} GB (Daily Avg)`
  }));
  mergeRecords(newRecords);
  renderGapsModal();
  const msgEl = document.getElementById('gaps-status-msg');
  if (msgEl) {
    msgEl.className = 'status-msg success';
    msgEl.textContent = `Filled ${newRecords.length} missing days with daily average (${avgGB.toFixed(2)} GB/d).`;
  }
}

// Client-side MTN SMS Parser (Works fully offline or on Vercel)
function parseMtnSmsClient(text) {
  const records = [];
  const regex = /Y'?ello,?\s*(?:your\s*)?(corrected\s*)?data\s*usage\s*for\s*(\d{2}-\d{2}-\d{4})\s*is\s*([\d.]+)\s*(GB|MB|KB)/gi;
  let match;
  while ((match = regex.exec(String(text || ''))) !== null) {
    const isCorrected = Boolean(match[1]);
    const dateParts = match[2].split('-');
    const date = `${dateParts[2]}-${dateParts[1]}-${dateParts[0]}`;
    const value = parseFloat(match[3]);
    let unit = match[4].toUpperCase();
    if (unit === 'GB' && value > 500) {
      unit = 'MB';
    }
    const multiplier = unit === 'GB' ? 1 : (unit === 'MB' ? 1 / 1024 : 1 / (1024 * 1024));
    const usageGB = parseFloat((value * multiplier).toFixed(2));
    records.push({
      date,
      usageGB,
      usageBytes: Math.round(usageGB * 1024 * 1024 * 1024),
      downloadBytes: null,
      uploadBytes: null,
      isCorrected,
      sourceId: 'mtn-sms-client',
      sourceType: 'provider-sms',
      sourceLabel: isCorrected ? 'MTN Corrected SMS' : 'MTN Usage SMS',
      confidence: 'provider-reported',
      granularity: 'day',
      observedAt: new Date().toISOString(),
      rawMessage: match[0]
    });
  }
  return records;
}

// Handle SMS Parsing & Import
async function handleSmsImport() {
  const text = document.getElementById('sms-import-text').value.trim();
  const msgEl = document.getElementById('import-status-msg');
  if (!text) {
    msgEl.className = 'status-msg error';
    msgEl.textContent = 'Please paste MTN SMS text to import.';
    return;
  }

  const parsedRecords = parseMtnSmsClient(text);
  if (parsedRecords.length === 0) {
    msgEl.className = 'status-msg error';
    msgEl.textContent = 'No MTN usage messages detected. Check text format.';
    return;
  }

  mergeRecords(parsedRecords, 'MTN SMS Import');

  if (serviceAuthority === 'local-service') {
    fetch('/api/parse-sms', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text })
    }).catch(() => {});
  }

  msgEl.className = 'status-msg success';
  msgEl.textContent = `Successfully imported ${parsedRecords.length} daily record(s)!`;
  document.getElementById('sms-import-text').value = '';
  setTimeout(() => closeModal('import-modal'), 1200);
}

// Handle Manual Single Day Record
function handleManualRecord(e) {
  e.preventDefault();
  const date = document.getElementById('manual-date').value;
  const usageGB = parseFloat(document.getElementById('manual-gb').value);
  const msgEl = document.getElementById('import-status-msg');

  if (!date || isNaN(usageGB) || usageGB < 0) {
    msgEl.className = 'status-msg error';
    msgEl.textContent = 'Please provide a valid date and non-negative GB value.';
    return;
  }

  const record = {
    date,
    usageGB: parseFloat(usageGB.toFixed(2)),
    usageBytes: Math.round(usageGB * 1024 * 1024 * 1024),
    downloadBytes: null,
    uploadBytes: null,
    isCorrected: false,
    sourceId: 'manual-entry',
    sourceType: 'manual',
    sourceLabel: 'Manual Entry',
    confidence: 'observed',
    granularity: 'day',
    observedAt: new Date().toISOString(),
    rawMessage: `Manual log: ${usageGB.toFixed(2)} GB`
  };

  mergeRecords([record], 'Manual Entry');
  msgEl.className = 'status-msg success';
  msgEl.textContent = `Saved record for ${date} (${usageGB.toFixed(2)} GB)!`;
  document.getElementById('manual-record-form').reset();
  setTimeout(() => closeModal('import-modal'), 1200);
}

// Full JSON Backup Export
function exportJsonBackup() {
  const exportData = {
    ...currentData,
    exportedAt: new Date().toISOString(),
    wifiwatchVersion: '1.0.0'
  };
  const jsonStr = JSON.stringify(exportData, null, 2);
  const blob = new Blob([jsonStr], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `wifiwatch_backup_${new Date().toISOString().substring(0, 10)}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// Full JSON Backup Restore
function importJsonBackup(file) {
  if (!file) return;
  const reader = new FileReader();
  const msgEl = document.getElementById('backup-status-msg');
  reader.onload = async (e) => {
    try {
      const parsed = JSON.parse(e.target.result);
      if (!parsed || (!Array.isArray(parsed.records) && !Array.isArray(parsed.recordVariants))) {
        throw new Error('Invalid WiFiWatch backup format.');
      }
      applyDashboardState(parsed);
      if (serviceAuthority === 'local-service') {
        fetch('/api/restore', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(parsed)
        }).catch(() => {});
      }
      if (msgEl) {
        msgEl.className = 'status-msg success';
        msgEl.textContent = `Restored ${currentData.records.length} records successfully!`;
        setTimeout(() => closeModal('backup-modal'), 1200);
      }
    } catch (err) {
      if (msgEl) {
        msgEl.className = 'status-msg error';
        msgEl.textContent = 'Restore error: ' + err.message;
      }
    }
  };
  reader.readAsText(file);
}

// CSV Export from Local Browser Records
function exportCsv() {
  const records = currentData.records || [];
  let csv = 'Date,Usage_GB,Status,Raw_Message\n';
  records.forEach(r => {
    const msg = (r.rawMessage || '').replace(/"/g, '""');
    csv += `"${r.date}",${r.usageGB},"${r.isCorrected ? 'Corrected' : (r.sourceLabel || 'Daily Summary')}","${msg}"\n`;
  });
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `wifiwatch_data_history_${new Date().toISOString().substring(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// Initialize Application
document.addEventListener('DOMContentLoaded', () => {
  initChart();
  fetchData();

  // Segmented Mode Switcher
  document.getElementById('mode-unlimited').addEventListener('click', () => setPlanMode(true));
  document.getElementById('mode-custom').addEventListener('click', () => setPlanMode(false));

  // Settings update
  document.getElementById('calculator-form').addEventListener('submit', handleSettingsUpdate);

  // Router sync modal
  document.getElementById('btn-sync-router').addEventListener('click', () => openModal('sync-modal'));
  document.getElementById('close-sync-modal').addEventListener('click', () => closeModal('sync-modal'));
  document.getElementById('btn-cancel-sync').addEventListener('click', () => closeModal('sync-modal'));
  document.getElementById('btn-exec-sync').addEventListener('click', handleRouterSync);

  // Gaps modal
  document.getElementById('btn-open-gaps-modal').addEventListener('click', () => {
    renderGapsModal();
    openModal('gaps-modal');
  });
  document.getElementById('close-gaps-modal').addEventListener('click', () => closeModal('gaps-modal'));
  document.getElementById('btn-cancel-gaps').addEventListener('click', () => closeModal('gaps-modal'));
  document.getElementById('btn-fill-gaps-zero').addEventListener('click', fillGapsWithZero);
  document.getElementById('btn-fill-gaps-avg').addEventListener('click', fillGapsWithAvg);

  // Import / Add Modal
  document.getElementById('btn-open-import').addEventListener('click', () => openModal('import-modal'));
  document.getElementById('close-import-modal').addEventListener('click', () => closeModal('import-modal'));
  document.getElementById('btn-cancel-import').addEventListener('click', () => closeModal('import-modal'));
  document.getElementById('btn-parse-sms').addEventListener('click', handleSmsImport);
  document.getElementById('manual-record-form').addEventListener('submit', handleManualRecord);

  // Modal Tab Switching
  document.querySelectorAll('.modal-tab-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const tabTarget = e.target.dataset.tab;
      const modal = e.target.closest('.modal-box');
      if (modal) {
        modal.querySelectorAll('.modal-tab-btn').forEach(b => b.classList.remove('active'));
        modal.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
        e.target.classList.add('active');
        const targetEl = modal.querySelector(`#${tabTarget}`);
        if (targetEl) targetEl.classList.add('active');
      }
    });
  });

  // Backup & Restore Modal
  document.getElementById('btn-open-backup').addEventListener('click', () => openModal('backup-modal'));
  document.getElementById('close-backup-modal').addEventListener('click', () => closeModal('backup-modal'));
  document.getElementById('btn-cancel-backup').addEventListener('click', () => closeModal('backup-modal'));
  document.getElementById('btn-download-json-backup').addEventListener('click', exportJsonBackup);

  const fileInput = document.getElementById('backup-file-input');
  const triggerBtn = document.getElementById('btn-trigger-file-upload');
  if (triggerBtn && fileInput) {
    triggerBtn.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', (e) => {
      if (e.target.files && e.target.files[0]) {
        importJsonBackup(e.target.files[0]);
      }
    });
  }

  // Export CSV & Ping
  const exportBtn = document.getElementById('btn-export-csv');
  if (exportBtn) exportBtn.addEventListener('click', exportCsv);

  const pingBtn = document.getElementById('btn-ping');
  if (pingBtn) pingBtn.addEventListener('click', handlePing);

  // Privacy Toggle
  const privacyBtn = document.getElementById('btn-privacy-toggle');
  if (privacyBtn) {
    privacyBtn.addEventListener('click', () => {
      isPrivacyOn = !isPrivacyOn;
      localStorage.setItem('wifiwatch_privacy', isPrivacyOn);
      applyPrivacyMode();
    });
  }

  // Chart Time Range Pills
  document.querySelectorAll('.time-pills .pill-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      document.querySelectorAll('.time-pills .pill-btn').forEach(b => b.classList.remove('active'));
      e.target.classList.add('active');
      activeChartRange = e.target.dataset.range;
      renderDashboard();
    });
  });

  // Router preset selector toggle
  const presetSelect = document.getElementById('router-preset-select');
  const customIpGroup = document.getElementById('custom-ip-group');
  if (presetSelect && customIpGroup) {
    presetSelect.addEventListener('change', (e) => {
      customIpGroup.style.display = e.target.value === 'custom' ? 'block' : 'none';
    });
  }

  applyPrivacyMode();
});

function setPlanMode(isUnlimited) {
  const modeUnlimitedBtn = document.getElementById('mode-unlimited');
  const modeCustomBtn = document.getElementById('mode-custom');
  const groupCap = document.getElementById('group-monthly-cap');

  if (isUnlimited) {
    modeUnlimitedBtn.classList.add('active');
    modeCustomBtn.classList.remove('active');
    groupCap.style.display = 'none';
  } else {
    modeCustomBtn.classList.add('active');
    modeUnlimitedBtn.classList.remove('active');
    groupCap.style.display = 'flex';
  }
}

async function refreshFromService() {
  if (serviceAuthority !== 'local-service') return false;
  try {
    const res = await fetch('/api/history', { cache: 'no-store' });
    if (!res.ok) return false;
    return applyDashboardState(await res.json());
  } catch (err) {
    return false;
  }
}

async function loadServiceConfig() {
  try {
    const response = await fetch('/api/config', { cache: 'no-store' });
    if (!response.ok) return null;
    serviceConfig = await response.json();
    if (serviceConfig.dataAuthority) {
      serviceAuthority = serviceConfig.dataAuthority;
    }
    return serviceConfig;
  } catch (err) {
    return null;
  }
}

async function startConfiguredCollector() {
  if (startupCollectorAttempted) return;
  startupCollectorAttempted = true;

  try {
    const config = serviceConfig || await loadServiceConfig();
    if (!config) return;
    if (!config.autoSyncEnabled) {
      if (!currentData.lastSync?.success && !sessionStorage.getItem('wifiwatch_connection_prompted')) {
        sessionStorage.setItem('wifiwatch_connection_prompted', '1');
        setTimeout(() => openModal('sync-modal'), 0);
      }
      return;
    }

    const syncResponse = await fetch('/api/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ collectorId: config.defaultCollectorId || 'auto', routerIp: config.defaultRouterIp })
    });
    if (syncResponse.ok) {
      const result = await syncResponse.json();
      if (result.data) applyDashboardState(result.data);
    }
  } catch (err) {
    console.warn('Configured collector did not start:', err.message);
  }
}

function startDashboardPolling() {
  if (serviceAuthority !== 'local-service' || dashboardPollTimer) return;
  dashboardPollTimer = setInterval(() => {
    void refreshFromService();
  }, 30000);
}

// Fetch Initial Data
async function fetchData() {
  const local = loadLocalData();
  await loadServiceConfig();

  // Pre-load browser local data so client records are never lost
  if (local) {
    applyDashboardState(local);
  }

  if (serviceAuthority === 'local-service') {
    const loadedFromService = await refreshFromService();
    if (!loadedFromService && !local) applyDashboardState(DEFAULT_DATA);
  } else if (!local) {
    const seededFromService = await (async () => {
      try {
        const res = await fetch('/api/history', { cache: 'no-store' });
        if (!res.ok) return false;
        return applyDashboardState(await res.json());
      } catch (err) {
        return false;
      }
    })();
    if (!seededFromService) applyDashboardState(DEFAULT_DATA);
  }
  startDashboardPolling();
  await startConfiguredCollector();
}

// Month Selector - always includes current calendar month + all historical months
function renderMonthSelector() {
  const selectEl = document.getElementById('month-selector');
  const records = currentData.records || [];

  const monthMap = new Map();

  // 1. Always include the current real-world month
  const now = new Date();
  const currentMonthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const currentMonthLabel = now.toLocaleString('en-US', { month: 'long', year: 'numeric' });
  monthMap.set(currentMonthKey, currentMonthLabel);

  // 2. Add all recorded months from usage history
  records.forEach(r => {
    if (!r.date) return;
    const monthKey = r.date.substring(0, 7);
    const [year, month] = monthKey.split('-');
    const dateObj = new Date(parseInt(year, 10), parseInt(month, 10) - 1, 1);
    const monthLabel = dateObj.toLocaleString('en-US', { month: 'long', year: 'numeric' });
    monthMap.set(monthKey, monthLabel);
  });

  const monthKeys = Array.from(monthMap.keys()).sort().reverse();

  if (!selectedMonthKey || !monthMap.has(selectedMonthKey)) {
    selectedMonthKey = monthKeys[0];
  }

  selectEl.innerHTML = monthKeys.map(key => `
    <option value="${key}" ${key === selectedMonthKey ? 'selected' : ''}>${monthMap.get(key)}</option>
  `).join('');

  selectEl.onchange = (e) => {
    selectedMonthKey = e.target.value;
    currentPage = 1;
    renderDashboard();
  };
}

// Render Dashboard UI components
function renderDashboard() {
  const { settings, records } = currentData;
  const isUnlimited = settings.isUnlimited !== false;

  if (!selectedMonthKey && records.length > 0) {
    selectedMonthKey = records[records.length - 1].date.substring(0, 7);
  }

  const filteredRecords = records.filter(r => selectedMonthKey && r.date.startsWith(selectedMonthKey));

  setPlanMode(isUnlimited);
  document.getElementById('monthlyLimit').value = settings.monthlyLimitGB || 1000;
  document.getElementById('cycleStartDay').value = settings.cycleStartDay || 1;

  // Dynamic Device Model Tag
  const deviceTag = document.getElementById('detected-device-tag');
  if (deviceTag) {
    let model = settings.detectedModel || 'Connect a router to begin';
    if (model === 'MTN MiFi / Router' || model === 'ZLT X17U' || model === 'X17U') {
      model = 'MTN 5G ODU • ZLT X17U';
    }
    deviceTag.textContent = model;
  }

  const routerLink = document.getElementById('detected-router-link');
  const configuredSource = (currentData.sources || []).find(source => source.routerIp);
  const routerIp = currentData.lastSync?.routerIp || configuredSource?.routerIp || '192.168.0.1';
  if (routerLink) {
    routerLink.textContent = routerIp || 'not connected';
    routerLink.href = routerIp ? `http://${routerIp}/` : '#';
  }

  // 5G Signal & Tower Health
  const diag = currentData.diagnostics || currentData.lastSync?.diagnostics || {};
  const rsrpEl = document.getElementById('sig-rsrp');
  const rsrp5gEl = document.getElementById('sig-rsrp5g');
  const rsrqEl = document.getElementById('sig-rsrq');
  const sinrEl = document.getElementById('sig-sinr');
  const gatewayIpEl = document.getElementById('info-gateway-ip');
  const bandEl = document.getElementById('info-band');
  const cellIdEl = document.getElementById('info-cell-id');
  const enodebIdEl = document.getElementById('info-enodeb-id');

  if (rsrpEl) rsrpEl.textContent = diag.rsrp || '-72 dBm';
  if (rsrp5gEl) rsrp5gEl.textContent = diag.rsrp5g || '-65 dBm';
  if (rsrqEl) rsrqEl.textContent = diag.rsrq || '-12 dB';
  if (sinrEl) sinrEl.textContent = diag.sinr || '15 dB';
  if (gatewayIpEl) gatewayIpEl.textContent = routerIp;
  if (bandEl) bandEl.textContent = diag.band || 'MTN 5G NSA • B7+B3';
  if (cellIdEl) cellIdEl.textContent = diag.cellId || '6301153';
  if (enodebIdEl) enodebIdEl.textContent = diag.enodebId || '405521';

  const totalGB = filteredRecords.reduce((sum, r) => sum + (Number(r.usageGB) || 0), 0);
  const totalDays = filteredRecords.length;
  const dailyAvg = totalDays > 0 ? (totalGB / totalDays) : 0;

  const latestRecord = filteredRecords.length > 0
    ? filteredRecords[filteredRecords.length - 1]
    : { usageGB: 0, date: '--' };

  const [yearStr, monthStr] = (selectedMonthKey || '2026-08').split('-');
  const selectedYear = parseInt(yearStr, 10);
  const selectedMonth = parseInt(monthStr, 10);
  const daysInMonth = new Date(selectedYear, selectedMonth, 0).getDate();
  const now = new Date();
  const currentDay = now.getDate();
  const remainingDays = Math.max(1, daysInMonth - currentDay);

  const remainingBudget = Math.max(0, settings.monthlyLimitGB - totalGB);
  const recommendedDailyCap = remainingBudget / remainingDays;
  const projectedMonthEnd = dailyAvg * daysInMonth;

  document.getElementById('val-total-usage').textContent = `${totalGB.toFixed(2)} GB`;
  document.getElementById('sub-total-days').textContent = `${totalDays} days recorded in month`;

  document.getElementById('val-latest-usage').textContent = `${latestRecord.usageGB.toFixed(2)} GB`;
  document.getElementById('sub-latest-date').textContent = `Date: ${latestRecord.date}`;

  document.getElementById('val-daily-avg').textContent = `${dailyAvg.toFixed(2)} GB/d`;
  document.getElementById('sub-projected').textContent = `Projected: ${projectedMonthEnd.toFixed(1)} GB/mo`;

  const titleEl = document.getElementById('plan-status-title');
  const descEl = document.getElementById('plan-status-desc');
  const badgeEl = document.getElementById('banner-badge');
  const fillEl = document.getElementById('progress-fill');
  const budgetValEl = document.getElementById('val-daily-budget');
  const budgetSubEl = document.getElementById('sub-remaining-budget');
  const statusTagEl = document.getElementById('res-status-tag');
  const burnRateEl = document.getElementById('res-burn-rate');
  const projectedEndEl = document.getElementById('res-projected-end');

  burnRateEl.textContent = `${dailyAvg.toFixed(2)} GB/day`;
  projectedEndEl.textContent = `${projectedMonthEnd.toFixed(2)} GB`;

  if (isUnlimited) {
    budgetValEl.textContent = 'Unlimited';
    budgetSubEl.textContent = 'No Cap Active';

    titleEl.textContent = 'Unlimited Data Plan Active';
    descEl.textContent = `Month Total: ${totalGB.toFixed(2)} GB across ${totalDays} days recorded`;
    badgeEl.textContent = 'UNLIMITED';
    fillEl.style.width = '100%';

    statusTagEl.textContent = 'Unlimited Plan';
    statusTagEl.style.color = 'var(--accent-yellow)';
  } else {
    const pct = Math.min(100, (totalGB / settings.monthlyLimitGB) * 100);

    budgetValEl.textContent = `${recommendedDailyCap.toFixed(2)} GB/d`;
    budgetSubEl.textContent = 'Target daily limit';

    titleEl.textContent = `Using ${totalGB.toFixed(2)} GB of ${settings.monthlyLimitGB} GB Plan`;
    descEl.textContent = `${remainingDays} days left in cycle • ${remainingBudget.toFixed(2)} GB remaining`;
    badgeEl.textContent = `${pct.toFixed(1)}%`;
    fillEl.style.width = `${pct}%`;

    if (projectedMonthEnd > settings.monthlyLimitGB) {
      statusTagEl.textContent = `Over Cap (+${(projectedMonthEnd - settings.monthlyLimitGB).toFixed(1)} GB)`;
      statusTagEl.style.color = 'var(--accent-red)';
    } else {
      statusTagEl.textContent = 'Within Budget';
      statusTagEl.style.color = 'var(--accent-green)';
    }
  }

  updateChart(filteredRecords);
  renderTable(filteredRecords);
  applyPrivacyMode();
}

// Privacy Mode Manager
function applyPrivacyMode() {
  const toggleBtn = document.getElementById('btn-privacy-toggle');
  const privacyText = document.getElementById('privacy-text');
  const privacyIcon = document.getElementById('privacy-icon');
  const sensitiveElements = document.querySelectorAll('.sensitive-data');
  const routerLink = document.getElementById('detected-router-link');

  if (isPrivacyOn) {
    if (toggleBtn) toggleBtn.classList.add('btn-privacy-active');
    if (privacyText) privacyText.textContent = 'Privacy On';
    if (privacyIcon) privacyIcon.textContent = '🔒';
    sensitiveElements.forEach(el => el.classList.add('masked'));
    if (routerLink) routerLink.textContent = '••••••••';
  } else {
    if (toggleBtn) toggleBtn.classList.remove('btn-privacy-active');
    if (privacyText) privacyText.textContent = 'Privacy Off';
    if (privacyIcon) privacyIcon.textContent = '🛡️';
    sensitiveElements.forEach(el => el.classList.remove('masked'));
    const configuredSource = (currentData.sources || []).find(source => source.routerIp);
    const routerIp = currentData.lastSync?.routerIp || configuredSource?.routerIp;
    if (routerLink) routerLink.textContent = routerIp || '192.168.0.1';
  }
}

// Chart.js Bar Chart
function initChart() {
  const canvas = document.getElementById('usageChart');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');

  if (chartInstance) {
    chartInstance.destroy();
    chartInstance = null;
  }

  chartInstance = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: [],
      datasets: [{
        label: 'Daily Usage (GB)',
        data: [],
        backgroundColor: '#ffcc00',
        borderRadius: 4,
        borderSkipped: false,
        barThickness: 28
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: '#18181b',
          titleColor: '#f4f4f5',
          bodyColor: '#a1a1aa',
          borderColor: '#27272a',
          borderWidth: 1,
          padding: 10,
          displayColors: false,
          callbacks: {
            label: (context) => ` ${context.parsed.y} GB`
          }
        }
      },
      scales: {
        x: {
          grid: { display: false },
          ticks: { color: '#71717a', font: { family: 'Inter', size: 11 } }
        },
        y: {
          grid: { color: '#18181b' },
          ticks: { color: '#71717a', font: { family: 'Inter', size: 11 } },
          beginAtZero: true
        }
      }
    }
  });
}

function updateChart(records) {
  if (!chartInstance) initChart();
  if (!chartInstance) return;

  let filtered = [...records];
  if (activeChartRange === '7d') filtered = filtered.slice(-7);
  else if (activeChartRange === '14d') filtered = filtered.slice(-14);
  else if (activeChartRange === '30d') filtered = filtered.slice(-30);

  const labels = filtered.map(r => r.date.substring(5));
  const data = filtered.map(r => r.usageGB);

  chartInstance.data.labels = labels;
  chartInstance.data.datasets[0].data = data;
  chartInstance.update();

  const highUsageDay = records.find(r => r.usageGB > 30);
  if (highUsageDay && 'Notification' in window && Notification.permission === 'granted') {
    new Notification('MTN ODU High Usage Alert', {
      body: `High consumption recorded on ${highUsageDay.date}: ${highUsageDay.usageGB} GB`
    });
  }
}

// History Table with Pagination
function renderTable(records) {
  const tbody = document.getElementById('table-body');
  document.getElementById('records-count').textContent = `${records.length} entries`;

  if (records.length === 0) {
    tbody.innerHTML = `<tr><td colspan="3" style="text-align: center; color: var(--text-muted); padding: 36px 16px;">No usage records found yet. Click <strong>Sync Router</strong> or <strong>+ Import / Add</strong> to populate data.</td></tr>`;
    const pageIndicator = document.getElementById('page-indicator');
    const prevBtn = document.getElementById('btn-prev-page');
    const nextBtn = document.getElementById('btn-next-page');
    if (pageIndicator) pageIndicator.textContent = 'Page 1 of 1';
    if (prevBtn) prevBtn.disabled = true;
    if (nextBtn) nextBtn.disabled = true;
    return;
  }

  const sorted = [...records].reverse();
  const totalPages = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE));
  if (currentPage > totalPages) currentPage = totalPages;

  const startIdx = (currentPage - 1) * PAGE_SIZE;
  const pageRecords = sorted.slice(startIdx, startIdx + PAGE_SIZE);

  tbody.innerHTML = pageRecords.map(r => {
    let pillClass = 'regular';
    if (r.isCorrected) pillClass = 'corrected';
    else if (r.sourceType === 'estimated') pillClass = 'estimated';
    else if (r.sourceType === 'manual') pillClass = 'manual';

    const typeLabel = r.isCorrected
      ? 'Corrected'
      : (r.sourceLabel || (r.sourceType === 'estimated' ? 'Estimated' : 'Daily Log'));

    return `
      <tr>
        <td><strong>${r.date}</strong></td>
        <td><strong>${r.usageGB.toFixed(2)} GB</strong></td>
        <td>
          <span class="type-pill ${pillClass}">
            ${typeLabel}
          </span>
        </td>
      </tr>
    `;
  }).join('');

  const prevBtn = document.getElementById('btn-prev-page');
  const nextBtn = document.getElementById('btn-next-page');
  const pageIndicator = document.getElementById('page-indicator');

  if (pageIndicator && prevBtn && nextBtn) {
    pageIndicator.textContent = `Page ${currentPage} of ${totalPages}`;
    prevBtn.disabled = currentPage <= 1;
    nextBtn.disabled = currentPage >= totalPages;

    prevBtn.onclick = () => {
      if (currentPage > 1) {
        currentPage--;
        renderTable(records);
      }
    };

    nextBtn.onclick = () => {
      if (currentPage < totalPages) {
        currentPage++;
        renderTable(records);
      }
    };
  }
}

// Settings Update Handler
async function handleSettingsUpdate(e) {
  e.preventDefault();
  const isUnlimited = document.getElementById('mode-unlimited').classList.contains('active');
  const monthlyLimitGB = parseFloat(document.getElementById('monthlyLimit').value) || 1000;
  const cycleStartDay = parseInt(document.getElementById('cycleStartDay').value, 10) || 1;

  if (serviceAuthority === 'local-service') {
    try {
      const response = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ monthlyLimitGB, cycleStartDay, isUnlimited })
      });
      if (response.ok) {
        applyDashboardState(await response.json());
        return;
      }
    } catch (err) {
      // Keep settings locally
    }
  }

  currentData.settings = { ...currentData.settings, monthlyLimitGB, cycleStartDay, isUnlimited };
  saveLocalData(currentData);
  renderDashboard();
}

// Chrome Extension Bridge
let isExtensionBridgeAvailable = false;
window.addEventListener('message', (event) => {
  if (event.source !== window || !event.data || event.data.source !== 'WIFIWATCH_EXTENSION') return;
  if (event.data.type === 'WIFIWATCH_BRIDGE_AVAILABLE') {
    isExtensionBridgeAvailable = true;
  }
});

function syncViaExtension(routerIp, password) {
  return new Promise((resolve, reject) => {
    const requestId = 'req_' + Math.random().toString(36).substring(2);
    const timeout = setTimeout(() => {
      window.removeEventListener('message', handler);
      reject(new Error('Extension request timed out'));
    }, 15000);

    function handler(event) {
      if (event.source !== window || !event.data || event.data.source !== 'WIFIWATCH_EXTENSION') return;
      if (event.data.type === 'WIFIWATCH_SYNC_RESPONSE' && event.data.requestId === requestId) {
        clearTimeout(timeout);
        window.removeEventListener('message', handler);
        if (event.data.response && event.data.response.success) {
          resolve(event.data.response);
        } else {
          reject(new Error(event.data.response?.error || 'Extension sync failed'));
        }
      }
    }

    window.addEventListener('message', handler);
    window.postMessage({
      source: 'WIFIWATCH_WEB_APP',
      type: 'WIFIWATCH_SYNC_REQUEST',
      requestId,
      routerIp,
      password
    }, '*');
  });
}

// Router Auto-Sync Handler
async function handleRouterSync() {
  const presetVal = document.getElementById('router-preset-select').value;
  let rawIp = presetVal === 'custom' ? document.getElementById('router-ip').value : presetVal;
  const routerIp = rawIp.replace(/^https?:\/\//i, '').replace(/\/.*$/, '').trim() || '192.168.0.1';

  const password = document.getElementById('router-password').value;
  const msgEl = document.getElementById('sync-status-msg');
  const execBtn = document.getElementById('btn-exec-sync');
  const isLocalApp = /^(localhost|127\.0\.0\.1)$/.test(window.location.hostname);

  localStorage.setItem('wifiwatch_router_ip', routerIp);

  msgEl.className = 'status-msg';
  msgEl.textContent = `Connecting to router at ${routerIp}...`;
  execBtn.disabled = true;

  try {
    let result;
    if (isExtensionBridgeAvailable && !isLocalApp) {
      if (!password) throw new Error('Enter the router admin password for the browser extension.');
      msgEl.textContent = `Connecting via Chrome Extension to ${routerIp}...`;
      result = await syncViaExtension(routerIp, password);
    } else {
      const res = await fetch('/api/sync-router', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ collectorId: 'auto', password, routerIp })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Sync failed');
      result = data;
    }

    const newRecords = result.data?.records || result.records || [];
    const model = result.source?.label || result.detectedModel || 'MTN Router';

    if (result.data) {
      applyDashboardState(result.data);
    } else {
      const sourceId = result.source?.id || (routerIp === '192.168.1.1' ? 'zte-f6600p' : 'zlt-sms');
      if (result.source) {
        const sources = (currentData.sources || []).filter(source => source.id !== result.source.id);
        currentData.sources = [...sources, result.source];
      }
      currentData.lastSync = {
        success: true,
        sourceId,
        sourceType: result.source?.kind || (routerIp === '192.168.1.1' ? 'router-counter' : 'router-sms'),
        sourceLabel: model,
        routerIp,
        observedAt: result.timestamp || new Date().toISOString(),
        status: result.counterStatus || 'historical',
        recordsIngested: newRecords.length,
        observationId: null,
        error: null
      };
      if (result.diagnostics) {
        currentData.diagnostics = result.diagnostics;
      }
      mergeRecords(newRecords, model);
    }

    msgEl.className = 'status-msg success';
    msgEl.textContent = ['baseline', 'counter-scope-changed'].includes(result.counterStatus)
      ? `Connected to ${model}. Baseline captured; the next sync will record usage.`
      : result.counterStatus === 'access-counters-unavailable'
        ? `Connected to ${model}, but access counters were temporarily unavailable. No usage was added.`
      : `Synced! Connected to ${model} (${result.sync?.recordsIngested ?? newRecords.length} records).`;

    setTimeout(() => {
      closeModal('sync-modal');
      execBtn.disabled = false;
      msgEl.textContent = '';
    }, 1200);
  } catch (err) {
    execBtn.disabled = false;
    msgEl.className = 'status-msg error';
    msgEl.textContent = 'Sync error: ' + err.message;
  }
}

function openModal(id) {
  const modal = document.getElementById(id);
  if (modal) modal.classList.add('active');
}

function closeModal(id) {
  const modal = document.getElementById(id);
  if (modal) modal.classList.remove('active');
}

// Ping Latency Diagnostics
async function handlePing() {
  const btn = document.getElementById('btn-ping');
  if (!btn) return;
  const originalText = btn.textContent;
  btn.textContent = 'Pinging...';
  btn.disabled = true;

  try {
    const routerIp = localStorage.getItem('wifiwatch_router_ip') || '192.168.0.1';
    const res = await fetch(`/api/ping?routerIp=${encodeURIComponent(routerIp)}`);
    const data = await res.json();
    if (data.status === 'online') {
      btn.textContent = `${data.latencyMs} ms`;
      btn.style.borderColor = 'var(--accent-green)';
      btn.style.color = 'var(--accent-green)';
    } else {
      btn.textContent = 'Offline';
      btn.style.borderColor = 'var(--accent-red)';
    }
  } catch (e) {
    btn.textContent = 'Error';
  }

  setTimeout(() => {
    btn.textContent = originalText;
    btn.disabled = false;
    btn.style.borderColor = '';
    btn.style.color = '';
  }, 2500);
}
