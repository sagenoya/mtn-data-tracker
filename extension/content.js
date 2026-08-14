// WiFiWatch Content Script Bridge

// Announce extension presence to the web application
function announcePresence() {
  window.postMessage({
    source: 'WIFIWATCH_EXTENSION',
    type: 'WIFIWATCH_BRIDGE_AVAILABLE',
    version: '1.0.0'
  }, '*');
}

// Announce on load and when requested
announcePresence();
setInterval(announcePresence, 2000);

// Listen for sync/ping requests from the web app
window.addEventListener('message', async (event) => {
  if (event.source !== window || !event.data || event.data.source !== 'WIFIWATCH_WEB_APP') {
    return;
  }

  const { type, requestId, routerIp, password } = event.data;

  if (type === 'WIFIWATCH_SYNC_REQUEST') {
    try {
      const response = await chrome.runtime.sendMessage({
        action: 'SYNC_ROUTER',
        routerIp,
        password
      });

      window.postMessage({
        source: 'WIFIWATCH_EXTENSION',
        type: 'WIFIWATCH_SYNC_RESPONSE',
        requestId,
        response
      }, '*');
    } catch (err) {
      window.postMessage({
        source: 'WIFIWATCH_EXTENSION',
        type: 'WIFIWATCH_SYNC_RESPONSE',
        requestId,
        response: { success: false, error: err.message }
      }, '*');
    }
  }

  if (type === 'WIFIWATCH_PING_REQUEST') {
    try {
      const response = await chrome.runtime.sendMessage({
        action: 'PING_ROUTER',
        routerIp
      });

      window.postMessage({
        source: 'WIFIWATCH_EXTENSION',
        type: 'WIFIWATCH_PING_RESPONSE',
        requestId,
        response
      }, '*');
    } catch (err) {
      window.postMessage({
        source: 'WIFIWATCH_EXTENSION',
        type: 'WIFIWATCH_PING_RESPONSE',
        requestId,
        response: { success: false, error: err.message }
      }, '*');
    }
  }
});
