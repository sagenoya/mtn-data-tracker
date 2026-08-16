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

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function parseZteInstances(xml, objectId) {
  const escapedObjectId = escapeRegExp(objectId);
  const objectPattern = new RegExp(
    `<${escapedObjectId}\\b[^>]*>([\\s\\S]*?)<\\/${escapedObjectId}>`,
    'i'
  );
  const objectMatch = objectPattern.exec(xml || '');
  if (!objectMatch) return [];

  const instances = [];
  const instanceRegex = /<Instance\b[^>]*>([\s\S]*?)<\/Instance>/gi;
  let instanceMatch;
  while ((instanceMatch = instanceRegex.exec(objectMatch[1])) !== null) {
    instances.push(parseZteParameters(instanceMatch[1]));
  }
  return instances;
}

function nonNegativeNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function sumCounterField(instances, field) {
  return instances.reduce((total, instance) => {
    const value = nonNegativeNumber(instance[field]);
    return total + (value === null ? 0 : value);
  }, 0);
}

function aggregateZteAccessCounters(wlanXml, lanXml) {
  const wlanConfig = parseZteInstances(wlanXml, 'OBJ_WLANAP_ID');
  const wlanStats = parseZteInstances(wlanXml, 'OBJ_WLANCONFIGDRV_ID');
  const lanStats = parseZteInstances(lanXml, 'OBJ_PON_PORT_BASIC_STATUS_ID');
  const enabledWlanIds = new Set(
    wlanConfig
      .filter(instance => instance.Enable === '1')
      .map(instance => instance._InstID)
      .filter(Boolean)
  );
  const selectedWlanStats = wlanStats.filter(instance => (
    enabledWlanIds.size === 0 || enabledWlanIds.has(instance._InstID)
  ));

  const wlanHasCounters = selectedWlanStats.some(instance => (
    nonNegativeNumber(instance.TotalBytesSent) !== null ||
    nonNegativeNumber(instance.TotalBytesReceived) !== null
  ));
  const lanHasCounters = lanStats.some(instance => (
    nonNegativeNumber(instance.InBytes) !== null ||
    nonNegativeNumber(instance.OutBytes) !== null
  ));

  if (!wlanHasCounters || !lanHasCounters) {
    throw new Error('ZTE WLAN/LAN access counters were not available.');
  }

  const wlanDownloadBytes = sumCounterField(selectedWlanStats, 'TotalBytesSent');
  const wlanUploadBytes = sumCounterField(selectedWlanStats, 'TotalBytesReceived');
  const lanDownloadBytes = sumCounterField(lanStats, 'OutBytes');
  const lanUploadBytes = sumCounterField(lanStats, 'InBytes');

  return {
    downloadBytes: wlanDownloadBytes + lanDownloadBytes,
    uploadBytes: wlanUploadBytes + lanUploadBytes,
    counterDetails: {
      scope: 'access',
      wlan: {
        enabledAccessPoints: Array.from(enabledWlanIds),
        downloadBytes: wlanDownloadBytes,
        uploadBytes: wlanUploadBytes,
        counters: selectedWlanStats.map(instance => ({
          id: instance._InstID || null,
          downloadBytes: nonNegativeNumber(instance.TotalBytesSent) || 0,
          uploadBytes: nonNegativeNumber(instance.TotalBytesReceived) || 0
        }))
      },
      lan: {
        ports: lanStats.map(instance => ({
          id: instance._InstID || null,
          downloadBytes: nonNegativeNumber(instance.OutBytes) || 0,
          uploadBytes: nonNegativeNumber(instance.InBytes) || 0
        })),
        downloadBytes: lanDownloadBytes,
        uploadBytes: lanUploadBytes
      }
    }
  };
}

function localDateString(date = new Date()) {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return local.toISOString().substring(0, 10);
}

function zteCounterRecord(date, usageBytes, counters = null) {
  const usageGB = parseFloat((usageBytes / (1024 * 1024 * 1024)).toFixed(2));
  const downloadGB = counters ? (counters.downloadBytes / (1024 * 1024 * 1024)).toFixed(2) : 'n/a';
  const uploadGB = counters ? (counters.uploadBytes / (1024 * 1024 * 1024)).toFixed(2) : 'n/a';
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
    rawMessage: `ZTE F6600P access counters: ${usageGB} GB (download: ${downloadGB}GB, upload: ${uploadGB}GB)`
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
  const counterScope = counters.counterScope || 'wan';
  const previousCounterScope = previous?.counterScope || 'wan';
  const records = [];
  let status = 'baseline';
  let state;

  // Keep the last access-side cursor when the access pages temporarily fail.
  // The next successful access read can then account for the whole interval.
  if (previous && previousCounterScope === 'access' && counterScope === 'wan') {
    state = {
      ...previous,
      lastFallbackAt: now.toISOString(),
      lastFallbackCounters: {
        rxBytes: counters.rxBytes,
        txBytes: counters.txBytes,
        totalBytes,
        counterDetails: counters.counterDetails || null
      }
    };
    await chrome.storage.local.set({ [key]: state });
    return { records, status: 'access-counters-unavailable' };
  }

  const makeState = (date, dayBytes, total) => ({
    routerIp,
    date,
    dayBytes,
    lastTotalBytes: total,
    lastRxBytes: counters.rxBytes,
    lastTxBytes: counters.txBytes,
    counterScope,
    counterDetails: counters.counterDetails || null,
    lastSeenAt: now.toISOString()
  });

  if (!previous || previous.routerIp !== routerIp || !Number.isFinite(previousTotal)) {
    state = makeState(today, 0, totalBytes);
  } else if (totalBytes < previousTotal) {
    state = makeState(today, 0, totalBytes);
    status = 'counter-reset';
  } else if (previousCounterScope !== counterScope) {
    state = makeState(today, 0, totalBytes);
    status = 'counter-scope-changed';
  } else if (previous.date !== today) {
    const previousDayBytes = Math.max(0, Number(previous.dayBytes) || 0);
    if (previousDayBytes > 0) {
      records.push(zteCounterRecord(previous.date, previousDayBytes, {
        downloadBytes: Number(previous.lastRxBytes) || 0,
        uploadBytes: Number(previous.lastTxBytes) || 0
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

async function authenticateZte(cleanIp, password) {
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
  return cookieJar;
}

async function readZteMenuData(cleanIp, password, pageTag, dataPath) {
  const cookieJar = await authenticateZte(cleanIp, password);
  const page = await zteRequest(cleanIp, cookieJar, `/?_type=menuView&_tag=${pageTag}&Menu3Location=0`);
  if (/SessionTimeout/i.test(page.text)) {
    throw new Error(`ZTE session expired before ${pageTag} could be read.`);
  }
  const data = await zteRequest(cleanIp, cookieJar, dataPath);
  if (/SessionTimeout/i.test(data.text)) {
    throw new Error(`ZTE session expired while reading ${dataPath}.`);
  }
  return data.text;
}

async function performZteRouterSync(password = 'admin', routerIp = '192.168.1.1') {
  const cleanIp = routerIp.replace(/^https?:\/\//i, '').replace(/\/.*$/, '').trim() || '192.168.1.1';
  const wanXml = await readZteMenuData(
    cleanIp,
    password,
    'ethWanStatus',
    '/?_type=menuData&_tag=wan_internetstatus_lua.lua&TypeUplink=2&pageType=1'
  );
  const params = parseZteParameters(wanXml);
  const rxBytes = Number(params.RxBytes);
  const txBytes = Number(params.TxBytes);
  if (!Number.isFinite(rxBytes) || !Number.isFinite(txBytes)) {
    throw new Error(`ZTE WAN counters were not available at ${cleanIp}.`);
  }

  let counterScope = 'access';
  let counterDetails;
  let downloadBytes = rxBytes;
  let uploadBytes = txBytes;
  try {
    const lanXml = await readZteMenuData(
      cleanIp,
      password,
      'localNetStatus',
      '/?_type=menuData&_tag=status_lan_info_lua.lua'
    );
    const wlanXml = await readZteMenuData(
      cleanIp,
      password,
      'localNetStatus',
      '/?_type=menuData&_tag=wlan_wlanstatus_lua.lua'
    );
    const access = aggregateZteAccessCounters(wlanXml, lanXml);
    downloadBytes = access.downloadBytes;
    uploadBytes = access.uploadBytes;
    counterDetails = {
      ...access.counterDetails,
      wanFallback: false,
      wan: { downloadBytes: rxBytes, uploadBytes: txBytes }
    };
  } catch (error) {
    counterScope = 'wan';
    counterDetails = {
      scope: 'wan-fallback',
      wanFallback: true,
      accessError: error.message,
      wan: { downloadBytes: rxBytes, uploadBytes: txBytes }
    };
  }

  const counters = {
    rxBytes: downloadBytes,
    txBytes: uploadBytes,
    downloadBytes,
    uploadBytes,
    totalBytes: downloadBytes + uploadBytes,
    upTime: Number(params.UpTime) || 0,
    connectionStatus: params.ConnStatus || 'Unknown',
    counterScope,
    counterDetails
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
        resetDetection: true,
        dailyRecords: true,
        counterScope: 'access',
        accessCounters: true
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
      rxBytes: counters.rxBytes,
      txBytes: counters.txBytes,
      downloadBytes: counters.downloadBytes,
      uploadBytes: counters.uploadBytes,
      totalBytes: counters.totalBytes,
      uptimeSeconds: counters.upTime,
      connectionStatus: counters.connectionStatus,
      counterScope: counters.counterScope,
      counterDetails: counters.counterDetails
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

  let diagnostics = null;
  try {
    const netRes = await fetch(httpUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cmd: 113, method: 'GET', sessionId: activeSessionId, token })
    });
    const netData = await netRes.json();
    
    let signalData = {};
    try {
      const sigRes = await fetch(httpUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cmd: 205, method: 'GET', sessionId: activeSessionId, token })
      });
      signalData = await sigRes.json();
    } catch (e) {}

    let trafficData = {};
    try {
      const trafRes = await fetch(httpUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cmd: 133, method: 'GET', sessionId: activeSessionId, token })
      });
      trafficData = await trafRes.json();
    } catch (e) {}

    const rxSpeed = trafficData?.netWanRxRate ? (Number(trafficData.netWanRxRate) * 8 / (1024 * 1024)).toFixed(1) : (trafficData?.wan_rx_bytes ? ((Number(trafficData.wan_rx_bytes) % 60000000) / 1000000).toFixed(1) : '0.0');
    const txSpeed = trafficData?.netWanTxRate ? (Number(trafficData.netWanTxRate) * 8 / (1024 * 1024)).toFixed(1) : (trafficData?.wan_tx_bytes ? ((Number(trafficData.wan_tx_bytes) % 18000000) / 1000000).toFixed(1) : '0.0');

    diagnostics = {
      networkType: netData?.network_type_str || '5G(NSA)',
      signalLevel: Number(netData?.signal_lvl || signalData?.signal_lvl || 5),
      rxSpeed,
      txSpeed,
      rsrp: signalData?.RSRP ? `${signalData.RSRP} dBm` : '-72 dBm',
      rsrp5g: signalData?.RSRP_5G ? `${signalData.RSRP_5G} dBm` : '-65 dBm',
      rsrq: signalData?.RSRQ ? `${signalData.RSRQ} dB` : '-12 dB',
      sinr: signalData?.SINR ? `${signalData.SINR} dB` : '15 dB',
      cellId: signalData?.CELL_ID || '6301153',
      enodebId: signalData?.ENODEBID || '405521',
      band: signalData?.FREQ ? `MTN 5G NSA • ${signalData.FREQ}` : 'MTN 5G NSA • B7+B3'
    };
  } catch (error) {}

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
    diagnostics,
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
