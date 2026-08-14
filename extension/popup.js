// WiFiWatch Popup Script

document.addEventListener('DOMContentLoaded', () => {
  const syncBtn = document.getElementById('btn-sync');
  const openDashboardBtn = document.getElementById('btn-open-dashboard');
  const routerSelect = document.getElementById('router-select');
  const passwordInput = document.getElementById('router-password');
  const msgEl = document.getElementById('sync-msg');

  syncBtn.addEventListener('click', async () => {
    const routerIp = routerSelect.value;
    const password = passwordInput.value || 'admin';

    syncBtn.disabled = true;
    syncBtn.textContent = 'Connecting...';
    msgEl.className = 'msg';
    msgEl.textContent = 'Fetching router SMS logs...';

    try {
      const response = await chrome.runtime.sendMessage({
        action: 'SYNC_ROUTER',
        routerIp,
        password
      });

      if (response && response.success) {
        msgEl.className = 'msg success';
        msgEl.textContent = `Synced ${response.records.length} logs from ${response.detectedModel}!`;
        
        // Save to chrome.storage.local
        await chrome.storage.local.set({ wifiwatch_last_sync: response });
      } else {
        msgEl.className = 'msg error';
        msgEl.textContent = response?.error || 'Failed to sync with router.';
      }
    } catch (err) {
      msgEl.className = 'msg error';
      msgEl.textContent = 'Sync error: ' + err.message;
    } finally {
      syncBtn.disabled = false;
      syncBtn.textContent = 'Sync Router Now';
    }
  });

  openDashboardBtn.addEventListener('click', () => {
    chrome.tabs.create({ url: 'https://wifi-watch.vercel.app/' });
  });
});
