// WiFiWatch Router Bridge Background Service Worker (Manifest V3)

async function sha256(message) {
  const msgBuffer = new TextEncoder().encode(message);
  const hashBuffer = await crypto.subtle.digest('SHA-256', msgBuffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

function parseMtnnSms(text) {
  const records = [];
  const regex = /Y'ello,?\s+(?:your\s+)?(?:(corrected)\s+)?data\s+usage\s+for\s+(\d{2}-\d{2}-\d{4})\s+is\s+([\d.]+)\s*(GB|MB)/gi;
  let match;
  while ((match = regex.exec(text)) !== null) {
    const isCorrected = !!match[1];
    const rawDate = match[2];
    const val = parseFloat(match[3]);
    const unit = match[4].toUpperCase();
    const usageGB = unit === 'MB' ? val / 1024 : val;
    const [d, m, y] = rawDate.split('-');
    const isoDate = `${y}-${m}-${d}`;
    records.push({
      date: isoDate,
      usageGB: parseFloat(usageGB.toFixed(2)),
      isCorrected
    });
  }
  return records;
}

async function performRouterSync(password = 'admin', routerIp = '192.168.0.1') {
  const cleanIp = routerIp.replace(/^https?:\/\//i, '').replace(/\/.*$/, '').trim() || '192.168.0.1';
  const httpUrl = `http://${cleanIp}/cgi-bin/http.cgi`;

  // Step 1: Fetch Token (cmd: 232)
  const tokenRes = await fetch(httpUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cmd: 232, method: 'GET', sessionId: '' })
  });

  const textBody = await tokenRes.text();
  if (textBody.trim().startsWith('<')) {
    throw new Error(`Device at ${cleanIp} returned HTML. Please check router IP address.`);
  }

  let tokenData;
  try {
    tokenData = JSON.parse(textBody);
  } catch (e) {
    throw new Error(`Invalid response from router at ${cleanIp}`);
  }

  const token = tokenData?.token || tokenData?.data?.token;
  if (!token) throw new Error(`Could not fetch security token from router at ${cleanIp}`);

  // Step 2: Login (cmd: 100)
  const passwdHash = await sha256(token + password);
  const sessionId = Math.random().toString(36).substring(2);

  const loginRes = await fetch(httpUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      cmd: 100,
      method: 'POST',
      username: 'admin',
      passwd: passwdHash,
      sessionId,
      isAutoUpgrade: '1',
      isCheckPasswd: '1'
    })
  });

  const loginData = await loginRes.json();
  if (loginData.login_fail === 'fail') throw new Error('Router password incorrect.');

  const activeSessionId = loginData.sessionId || sessionId;

  // Step 3: Detect Device Model (cmd: 1005)
  let detectedModel = (cleanIp === '192.168.0.1') ? 'MTN 5G ODU • ZLT X17U' : (cleanIp.includes('8.1') ? 'MTN Broadband 4G MiFi' : 'MTN Broadband Gateway');
  try {
    const devRes = await fetch(httpUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cmd: 1005, method: 'GET', sessionId: activeSessionId, token })
    });
    const devData = await devRes.json();
    const rawModel = devData?.board_type || devData?.model_name || devData?.product_name || devData?.model;
    if (rawModel) {
      if (/X17U|ODU/i.test(rawModel)) detectedModel = 'MTN 5G ODU • ZLT X17U';
      else if (/X28/i.test(rawModel)) detectedModel = 'MTN 5G ODU • ZLT X28';
      else if (/Fibre/i.test(rawModel)) detectedModel = `MTN FibreX • ${rawModel}`;
      else detectedModel = rawModel;
    }
  } catch (e) {}

  // Step 4: Fetch Multi-Page SMS Logs (Pages 1 to 3)
  let combinedText = '';
  for (let page = 1; page <= 3; page++) {
    try {
      const smsRes = await fetch(httpUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cmd: 12, method: 'GET', page_num: page, subcmd: 0, sessionId: activeSessionId, token })
      });
      const smsData = await smsRes.json();
      const rawList = typeof smsData?.sms_list === 'string' ? smsData.sms_list.split(',') : (smsData?.sms_list || []);
      rawList.forEach(item => {
        try {
          combinedText += '\n' + atob(item.trim());
        } catch (e) {
          if (typeof item === 'string') combinedText += '\n' + item;
        }
      });
    } catch (e) {}
  }

  const records = parseMtnnSms(combinedText);

  return {
    success: true,
    records,
    detectedModel,
    routerIp: cleanIp,
    parsedCount: records.length,
    timestamp: new Date().toISOString()
  };
}

// Handle runtime messages from content script & popup
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'SYNC_ROUTER') {
    performRouterSync(request.password, request.routerIp)
      .then(result => sendResponse(result))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true; // Keep message channel open for async response
  }

  if (request.action === 'PING_ROUTER') {
    const cleanIp = (request.routerIp || '192.168.0.1').replace(/^https?:\/\//i, '').replace(/\/.*$/, '').trim();
    const start = Date.now();
    fetch(`http://${cleanIp}/cgi-bin/http.cgi`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cmd: 232, method: 'GET', sessionId: '' })
    })
      .then(res => res.text())
      .then(() => sendResponse({ success: true, latencyMs: Date.now() - start }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }
});
