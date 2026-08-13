const STORAGE_KEY = 'wifiwatch_user_data';
const DEFAULT_DATA = {
  settings: { monthlyLimitGB: 1000, cycleStartDay: 1, isUnlimited: true, detectedModel: 'MTN 5G ODU • ZLT X17U' },
  records: []
};

let chartInstance = null;
let currentData = JSON.parse(JSON.stringify(DEFAULT_DATA));
let selectedMonthKey = null;
let currentPage = 1;
const PAGE_SIZE = 10;

// Request notification permission if available
if ('Notification' in window && Notification.permission === 'default') {
  Notification.requestPermission();
}

function loadLocalData() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && Array.isArray(parsed.records) && parsed.settings) {
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
  currentData.records = Array.from(map.values()).sort((a, b) => a.date.localeCompare(b.date));
  saveLocalData(currentData);
  renderMonthSelector();
  renderDashboard();
}

document.addEventListener('DOMContentLoaded', () => {
  initChart();
  fetchData();

  // Segmented Mode Switcher
  document.getElementById('mode-unlimited').addEventListener('click', () => setPlanMode(true));
  document.getElementById('mode-custom').addEventListener('click', () => setPlanMode(false));

  // Event Listeners
  document.getElementById('calculator-form').addEventListener('submit', handleSettingsUpdate);
  document.getElementById('btn-sync-router').addEventListener('click', () => openModal('sync-modal'));
  document.getElementById('close-sync-modal').addEventListener('click', () => closeModal('sync-modal'));
  document.getElementById('btn-cancel-sync').addEventListener('click', () => closeModal('sync-modal'));
  document.getElementById('btn-exec-sync').addEventListener('click', handleRouterSync);

  document.getElementById('btn-export-csv').addEventListener('click', exportCsv);

  const pingBtn = document.getElementById('btn-ping');
  if (pingBtn) pingBtn.addEventListener('click', handlePing);
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

// Fetch history from browser localStorage or seed from backend
async function fetchData() {
  const local = loadLocalData();
  if (local) {
    currentData = local;
    if (currentData.settings.isUnlimited === undefined) {
      currentData.settings.isUnlimited = true;
    }
    renderMonthSelector();
    renderDashboard();
    return;
  }

  try {
    const res = await fetch('/api/history');
    if (res.ok) {
      currentData = await res.json();
    } else {
      currentData = JSON.parse(JSON.stringify(DEFAULT_DATA));
    }
  } catch (err) {
    currentData = JSON.parse(JSON.stringify(DEFAULT_DATA));
  }

  if (currentData.settings.isUnlimited === undefined) {
    currentData.settings.isUnlimited = true;
  }
  saveLocalData(currentData);
  renderMonthSelector();
  renderDashboard();
}

// Populate Month Dropdown Options
function renderMonthSelector() {
  const selectEl = document.getElementById('month-selector');
  const records = currentData.records || [];
  
  const monthMap = new Map();
  records.forEach(r => {
    const monthKey = r.date.substring(0, 7); // YYYY-MM
    const [year, month] = monthKey.split('-');
    const dateObj = new Date(parseInt(year), parseInt(month) - 1, 1);
    const monthLabel = dateObj.toLocaleString('en-US', { month: 'long', year: 'numeric' });
    monthMap.set(monthKey, monthLabel);
  });

  const monthKeys = Array.from(monthMap.keys()).sort().reverse();
  
  if (monthKeys.length === 0) {
    const nowStr = new Date().toISOString().substring(0, 7);
    monthKeys.push(nowStr);
    monthMap.set(nowStr, new Date().toLocaleString('en-US', { month: 'long', year: 'numeric' }));
  }

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

  let filteredRecords = records.filter(r => selectedMonthKey && r.date.startsWith(selectedMonthKey));
  if (filteredRecords.length === 0 && records.length > 0) {
    filteredRecords = records;
  }

  setPlanMode(isUnlimited);
  document.getElementById('monthlyLimit').value = settings.monthlyLimitGB || 1000;
  document.getElementById('cycleStartDay').value = settings.cycleStartDay || 1;

  // Update Dynamic Device Model Tag
  const deviceTag = document.getElementById('detected-device-tag');
  if (deviceTag) {
    const model = settings.detectedModel || 'ZLT X17U';
    const isOdu = /X17U|ODU/i.test(model);
    const isFibre = /Fibre/i.test(model);
    let devLabel = 'MTN 5G Broadband';
    if (isOdu) devLabel = 'MTN 5G ODU';
    if (isFibre) devLabel = 'MTN FibreX';
    deviceTag.textContent = `${devLabel} • ${model}`;
  }

  const totalGB = filteredRecords.reduce((sum, r) => sum + r.usageGB, 0);
  const totalDays = filteredRecords.length;
  const dailyAvg = totalDays > 0 ? (totalGB / totalDays) : 0;
  
  const latestRecord = filteredRecords.length > 0 ? filteredRecords[filteredRecords.length - 1] : { usageGB: 0, date: '--' };

  const [yearStr, monthStr] = (selectedMonthKey || '2026-08').split('-');
  const selectedYear = parseInt(yearStr);
  const selectedMonth = parseInt(monthStr);
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

  if (isUnlimited) {
    budgetValEl.textContent = 'Unlimited';
    budgetSubEl.textContent = 'No Cap Active';

    titleEl.textContent = 'Unlimited Data Plan Active';
    descEl.textContent = `Month Total: ${totalGB.toFixed(2)} GB across ${totalDays} days recorded`;
    badgeEl.textContent = 'UNLIMITED';
    fillEl.style.width = '100%';

    document.getElementById('res-burn-rate').textContent = `${dailyAvg.toFixed(2)} GB/day`;
    document.getElementById('res-projected-end').textContent = `${projectedMonthEnd.toFixed(2)} GB`;
    statusTagEl.textContent = 'Unlimited Plan';
    statusTagEl.style.color = 'var(--accent-yellow)';
  } else {
    budgetValEl.textContent = `${recommendedDailyCap.toFixed(2)} GB/d`;
    budgetSubEl.textContent = `Target daily limit`;

    const pct = Math.min(100, (totalGB / settings.monthlyLimitGB) * 100);
    titleEl.textContent = `Using ${totalGB.toFixed(2)} GB of ${settings.monthlyLimitGB} GB Plan`;
    descEl.textContent = `${remainingDays} days left in cycle &bull; ${remainingBudget.toFixed(2)} GB remaining`;
    badgeEl.textContent = `${pct.toFixed(1)}%`;
    fillEl.style.width = `${pct}%`;

    document.getElementById('res-burn-rate').textContent = `${dailyAvg.toFixed(2)} GB/day`;
    document.getElementById('res-projected-end').textContent = `${projectedMonthEnd.toFixed(2)} GB`;

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
}

// Initialize Minimal Chart.js Bar Chart
function initChart() {
  const ctx = document.getElementById('usageChart').getContext('2d');
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

// Update Chart Data
function updateChart(records) {
  if (!chartInstance) return;
  const labels = records.map(r => r.date.substring(5)); // MM-DD
  const data = records.map(r => r.usageGB);

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

// Render Table Rows with 10-Item Pagination
function renderTable(records) {
  const tbody = document.getElementById('table-body');
  document.getElementById('records-count').textContent = `${records.length} entries`;

  if (records.length === 0) {
    tbody.innerHTML = `<tr><td colspan="3" style="text-align: center; color: var(--text-muted); padding: 36px 16px;">No usage records found yet. Click <strong>Sync Router</strong> to fetch your logs.</td></tr>`;
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

  tbody.innerHTML = pageRecords.map(r => `
    <tr>
      <td><strong>${r.date}</strong></td>
      <td><strong>${r.usageGB.toFixed(2)} GB</strong></td>
      <td>
        <span class="type-pill ${r.isCorrected ? 'corrected' : 'regular'}">
          ${r.isCorrected ? 'Corrected' : 'Daily Log'}
        </span>
      </td>
    </tr>
  `).join('');

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

// CSV Export from Local Browser Records
function exportCsv() {
  const records = currentData.records || [];
  let csv = 'Date,Usage_GB,Status,Raw_Message\n';
  records.forEach(r => {
    const msg = (r.rawMessage || '').replace(/"/g, '""');
    csv += `"${r.date}",${r.usageGB},"${r.isCorrected ? 'Corrected' : 'Daily Summary'}","${msg}"\n`;
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

// Settings Update Handler (Saved directly to localStorage)
function handleSettingsUpdate(e) {
  e.preventDefault();
  const isUnlimited = document.getElementById('mode-unlimited').classList.contains('active');
  const monthlyLimitGB = parseFloat(document.getElementById('monthlyLimit').value) || 1000;
  const cycleStartDay = parseInt(document.getElementById('cycleStartDay').value) || 1;

  currentData.settings = {
    ...currentData.settings,
    monthlyLimitGB,
    cycleStartDay,
    isUnlimited
  };
  saveLocalData(currentData);
  renderDashboard();
}

// Router Auto-Sync Handler (Merges router records into visitor's localStorage)
async function handleRouterSync() {
  const presetVal = document.getElementById('router-preset-select').value;
  let rawIp = presetVal === 'custom' ? document.getElementById('router-ip').value : presetVal;
  const routerIp = rawIp.replace(/^https?:\/\//i, '').replace(/\/.*$/, '').trim() || '192.168.0.1';
  
  const password = document.getElementById('router-password').value || 'admin';
  const msgEl = document.getElementById('sync-status-msg');
  const execBtn = document.getElementById('btn-exec-sync');

  msgEl.className = 'status-msg';
  msgEl.textContent = `Connecting to router at ${routerIp}...`;
  execBtn.disabled = true;

  try {
    const res = await fetch('/api/sync-router', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password, routerIp })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Sync failed');

    const newRecords = data.records || data.data?.records || [];
    const model = data.detectedModel || data.data?.settings?.detectedModel || 'MTN Router';
    
    mergeRecords(newRecords, model);

    msgEl.className = 'status-msg success';
    msgEl.textContent = `Synced! Connected to ${model} (${newRecords.length} records).`;
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

document.addEventListener('DOMContentLoaded', () => {
  const presetSelect = document.getElementById('router-preset-select');
  const customIpGroup = document.getElementById('custom-ip-group');
  if (presetSelect && customIpGroup) {
    presetSelect.addEventListener('change', (e) => {
      if (e.target.value === 'custom') {
        customIpGroup.style.display = 'block';
      } else {
        customIpGroup.style.display = 'none';
      }
    });
  }
});

function openModal(id) {
  const modal = document.getElementById(id);
  if (modal) modal.classList.add('active');
}

function closeModal(id) {
  const modal = document.getElementById(id);
  if (modal) modal.classList.remove('active');
}

// Ping Latency Diagnostics Handler
async function handlePing() {
  const btn = document.getElementById('btn-ping');
  if (!btn) return;
  const originalText = btn.textContent;
  btn.textContent = 'Pinging...';
  btn.disabled = true;

  try {
    const res = await fetch('/api/ping');
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
