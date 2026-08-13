let chartInstance = null;
let currentData = {
  settings: { monthlyLimitGB: 1000, cycleStartDay: 1, isUnlimited: true },
  records: []
};
let selectedMonthKey = null;
let currentPage = 1;
const PAGE_SIZE = 10;

// Request notification permission if available
if ('Notification' in window && Notification.permission === 'default') {
  Notification.requestPermission();
}

document.addEventListener('DOMContentLoaded', () => {
  initChart();
  fetchData();

  // Segmented Mode Switcher
  document.getElementById('mode-unlimited').addEventListener('click', () => setPlanMode(true));
  document.getElementById('mode-custom').addEventListener('click', () => setPlanMode(false));

  // Event Listeners
  document.getElementById('calculator-form').addEventListener('submit', handleSettingsUpdate);
  document.getElementById('btn-sync-router').addEventListener('click', handleRouterSync);
  document.getElementById('btn-export-csv').addEventListener('click', () => {
    window.location.href = '/api/export-csv';
  });

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

// Fetch current history from backend API
async function fetchData() {
  try {
    const res = await fetch('/api/history');
    if (!res.ok) throw new Error('Failed to fetch data');
    currentData = await res.json();
    
    if (currentData.settings.isUnlimited === undefined) {
      currentData.settings.isUnlimited = true;
    }
    
    renderMonthSelector();
    renderDashboard();
  } catch (err) {
    console.error('Error fetching data:', err);
  }
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
      <td><div class="raw-msg" title="${r.rawMessage}">${r.rawMessage}</div></td>
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

// Settings Update Handler
async function handleSettingsUpdate(e) {
  e.preventDefault();
  const isUnlimited = document.getElementById('mode-unlimited').classList.contains('active');
  const monthlyLimitGB = parseFloat(document.getElementById('monthlyLimit').value) || 1000;
  const cycleStartDay = parseInt(document.getElementById('cycleStartDay').value) || 1;

  try {
    const res = await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ monthlyLimitGB, cycleStartDay, isUnlimited })
    });
    currentData = await res.json();
    renderDashboard();
  } catch (err) {
    alert('Failed to save settings: ' + err.message);
  }
}

// Router Auto-Sync Handler
async function handleRouterSync() {
  const btn = document.getElementById('btn-sync-router');
  const originalHtml = btn.innerHTML;
  btn.innerHTML = '<span class="status-indicator"></span> Syncing...';
  btn.disabled = true;

  try {
    const res = await fetch('/api/sync-router', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'admin' })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Sync failed');

    btn.innerHTML = '<span class="status-indicator"></span> Synced!';
    currentData = data.data;
    renderDashboard();
  } catch (err) {
    btn.innerHTML = '<span class="status-indicator"></span> Sync Failed';
  }

  setTimeout(() => {
    btn.innerHTML = originalHtml;
    btn.disabled = false;
  }, 2000);
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
