// WiFiWatch Router Bridge Background Service Worker (Manifest V3)

async function sha256(message) {
  const msgBuffer = new TextEncoder().encode(message);
  const hashBuffer = await crypto.subtle.digest('SHA-256', msgBuffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

function updateCookies(response, cookieJar) {
  const rawCookie = response.headers.get('set-cookie') || '';
  rawCookie.split(/,(?=\s*[^;,=]+=)/).filter(Boolean).forEach(cookie => {
    const pair = cookie.split(';', 1)[0];
    const separator = pair.indexOf('=');
    if (separator > 0) {
      cookieJar[pair.substring(0, separator)] = pair.substring(separator + 1);
    }
  });
}

function getCookieHeader(cookieJar) {
  return Object.entries(cookieJar)
    .map(([key, value]) => `${key}=${value}`)
    .join('; ');
}

async function zteRequest(cleanIp, cookieJar, path, options = {}) {
  const headers = {
    'X-Requested-With': 'XMLHttpRequest',
    ...(options.headers || {})
  };
  const cookies = getCookieHeader(cookieJar);
  if (cookies) headers.Cookie = cookies;
  const response = await fetch(`http://${cleanIp}${path}`, {
    ...options,
    headers,
    credentials: 'include'
  });
  updateCookies(response, cookieJar);
  return { response, text: await response.text() };
}

function parseZteParameters(xml) {
  const values = {};
  const pairRegex = /<ParaName>\s*([^<]+?)\s*<\/ParaName>\s*<ParaValue>([\s\S]*?)<\/ParaValue>/gi;
  let match;
  while ((match = pairRegex.exec(xml)) !== null) {
    values[match[1].trim()] = match[2].replace(/<[^>]+>/g, '').trim();
  }
  return values;
}

function localDateString(date = new Date()) {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return local.toISOString().substring(0, 10);
}

function zteCounterRecord(date, usageBytes, counters = null) {
  const usageGB = parseFloat((usageBytes / (1024 * 1024 * 1024)).toFixed(2));
  const rxGB = counters ? (counters.rxBytes / (1024 * 1024 * 1024)).toFixed(2) : 'n/a';
  const txGB = counters ? (counters.txBytes / (1024 * 1024 * 1024)).toFixed(2) : 'n/a';
  return {
    date,
    usageBytes,
    downloadBytes: null,
    uploadBytes: null,
    usageGB,
    isCorrected: false,
    sourceId: 'zte-f6600p',
    sourceType: 'router-counter',
    sourceLabel: 'MTN FibreX • ZTE F6600P',
    confidence: 'observed',
    granularity: 'day',
    provenance: 'zte-f6600p',
    rawMessage: `ZTE F6600P WAN counters: ${usageGB} GB (RX: ${rxGB}GB, TX: ${txGB}GB)`
  };
}

async function updateZteCounterState(routerIp, counters) {
  const key = 'wifiwatch_zte_counter_state';
  const stored = await chrome.storage.local.get(key);
  const previous = stored[key];
  const now = new Date();
  const today = localDateString(now);
  const totalBytes = counters.rxBytes + counters.txBytes;
  const previousTotal = Number(previous?.lastTotalBytes);
  const records = [];
  let status = 'baseline';
  let state;

  const makeState = (date, dayBytes, total) => ({
    routerIp,
    date,
    dayBytes,
    lastTotalBytes: total,
    lastRxBytes: counters.rxBytes,
    lastTxBytes: counters.txBytes,
    lastSeenAt: now.toISOString()
  });

  if (!previous || previous.routerIp !== routerIp || !Number.isFinite(previousTotal)) {
    state = makeState(today, 0, totalBytes);
  } else if (totalBytes < previousTotal) {
    state = makeState(today, 0, totalBytes);
    status = 'counter-reset';
  } else if (previous.date !== today) {
    const previousDayBytes = Math.max(0, Number(previous.dayBytes) || 0);
    if (previousDayBytes > 0) {
      records.push(zteCounterRecord(previous.date, previousDayBytes, {
        rxBytes: Number(previous.lastRxBytes) || 0,
        txBytes: Number(previous.lastTxBytes) || 0
      }));
    }
    const increment = totalBytes - previousTotal;
    state = makeState(today, increment, totalBytes);
    if (increment > 0) records.push(zteCounterRecord(today, increment, counters));
    status = 'day-rolled';
  } else {
    const increment = totalBytes - previousTotal;
    const dayBytes = Math.max(0, Number(previous.dayBytes) || 0) + increment;
    state = makeState(today, dayBytes, totalBytes);
    records.push(zteCounterRecord(today, dayBytes, counters));
    status = 'updated';
  }

  await chrome.storage.local.set({ [key]: state });
  return { records, status };
}

async function performZteRouterSync(password = 'admin', routerIp = '192.168.1.1') {
  const cleanIp = routerIp.replace(/^https?:\/\//i, '').replace(/\/.*$/, '').trim() || '192.168.1.1';
  const cookieJar = {};
  const loginEntry = await zteRequest(cleanIp, cookieJar, '/?_type=loginData&_tag=login_entry');
  let loginState;
  try {
    loginState = JSON.parse(loginEntry.text);
  } catch (e) {
    throw new Error(`ZTE router at ${cleanIp} did not return a login session.`);
  }

  const challengeResponse = await zteRequest(cleanIp, cookieJar, '/?_type=loginData&_tag=login_token');
  const challengeMatch = challengeResponse.text.match(/>\s*([^<]+?)\s*</);
  const challenge = challengeMatch?.[1]?.trim();
  if (!challenge) throw new Error(`ZTE router at ${cleanIp} did not return a login challenge.`);

  const passwordHash = await sha256(password + challenge);
  const loginResult = await zteRequest(cleanIp, cookieJar, '/?_type=loginData&_tag=login_entry', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
    body: new URLSearchParams({
      action: 'login',
      Password: passwordHash,
      Username: 'admin',
      _sessionTOKEN: loginState?.sess_token || ''
    })
  });

  let loginData;
  try {
    loginData = JSON.parse(loginResult.text);
  } catch (e) {
    throw new Error('ZTE login returned an invalid response.');
  }
  if (!loginData?.sess_token || loginData.loginErrMsg) {
    throw new Error(loginData?.loginErrMsg || 'ZTE router password incorrect.');
  }

  await zteRequest(cleanIp, cookieJar, '/');
  const statusPage = await zteRequest(cleanIp, cookieJar, '/?_type=menuView&_tag=ethWanStatus&Menu3Location=0');
  if (/SessionTimeout/i.test(statusPage.text)) {
    throw new Error('ZTE session expired before WAN status could be read.');
  }
  const wanData = await zteRequest(cleanIp, cookieJar, '/?_type=menuData&_tag=wan_internetstatus_lua.lua&TypeUplink=2&pageType=1');
  const params = parseZteParameters(wanData.text);
  const rxBytes = Number(params.RxBytes);
  const txBytes = Number(params.TxBytes);
  if (!Number.isFinite(rxBytes) || !Number.isFinite(txBytes)) {
    throw new Error(`ZTE WAN counters were not available at ${cleanIp}.`);
  }

  const counters = {
    rxBytes,
    txBytes,
    totalBytes: rxBytes + txBytes,
    upTime: Number(params.UpTime) || 0,
    connectionStatus: params.ConnStatus || 'Unknown'
  };
  const counterResult = await updateZteCounterState(cleanIp, counters);
  return {
    success: true,
    schemaVersion: 1,
    source: {
      id: 'zte-f6600p',
      label: 'MTN FibreX • ZTE F6600P',
      kind: 'router-counter',
      model: 'ZTE F6600P',
      routerIp: cleanIp,
      capabilities: {
        historical: false,
        liveSnapshot: true,
        cumulativeCounters: true,
        resetDetection: true
      }
    },
    records: counterResult.records,
    detectedModel: 'MTN FibreX • ZTE F6600P',
    routerIp: cleanIp,
    transport: 'zte',
    counterStatus: counterResult.status,
    counters,
    snapshots: [{
      sourceId: 'zte-f6600p',
      routerIp: cleanIp,
      observedAt: new Date().toISOString(),
      rxBytes,
      txBytes,
      uptimeSeconds: counters.upTime,
      connectionStatus: counters.connectionStatus,
      counterScope: 'wan'
    }],
    parsedCount: counterResult.records.length,
    timestamp: new Date().toISOString()
  };
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
      usageBytes: Math.round((unit === 'MB' ? val / 1024 : val) * 1024 * 1024 * 1024),
      downloadBytes: null,
      uploadBytes: null,
      usageGB: parseFloat(usageGB.toFixed(2)),
      isCorrected,
      sourceId: 'zlt-sms',
      sourceType: 'router-sms',
      sourceLabel: 'MTN 5G ODU / ZLT SMS',
      confidence: 'provider-reported',
      granularity: 'day',
      provenance: 'zlt-sms'
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
    const landingRes = await fetch(`http://${cleanIp}/`, { credentials: 'include' });
    const landingBody = await landingRes.text();
    if (/F6600P|_type=loginData&_tag=login_entry|ZTE Corporation/i.test(landingBody)) {
      return performZteRouterSync(password, cleanIp);
    }
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

  // Step 4: Fetch SMS Logs (cmd: 12)
  const smsRes = await fetch(httpUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cmd: 12, method: 'GET', page_num: 1, subcmd: 0, sessionId: activeSessionId, token })
  });

  const smsData = await smsRes.json();
  const rawList = typeof smsData?.sms_list === 'string' ? smsData.sms_list.split(',') : (smsData?.sms_list || []);

  let combinedText = '';
  rawList.forEach(item => {
    try {
      combinedText += '\n' + atob(item.trim());
    } catch (e) {
      if (typeof item === 'string') combinedText += '\n' + item;
    }
  });

  const records = parseMtnnSms(combinedText);

  return {
    success: true,
    schemaVersion: 1,
    source: {
      id: 'zlt-sms',
      label: detectedModel,
      kind: 'router-sms',
      model: detectedModel,
      routerIp: cleanIp,
      capabilities: {
        historical: true,
        dailyRecords: true,
        cumulativeCounters: false
      }
    },
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
    fetch(`http://${cleanIp}/`, { method: 'GET', credentials: 'include' })
      .then(res => {
        if (!res.ok) throw new Error(`Router returned HTTP ${res.status}`);
        return res.text();
      })
      .then(() => sendResponse({ success: true, latencyMs: Date.now() - start }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }
});
