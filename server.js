const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;
const DB_FILE = path.join(__dirname, 'data_history.json');
const ROUTER_IP = '192.168.0.1';

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Ensure data_history.json exists
if (!fs.existsSync(DB_FILE)) {
  fs.writeFileSync(DB_FILE, JSON.stringify({
    settings: { monthlyLimitGB: 1000, cycleStartDay: 1, isUnlimited: true },
    records: [
      { date: '2026-08-07', usageGB: 7.47, isCorrected: false, rawMessage: "Y'ello, your data usage for 07-08-2026 is 7.47GB." },
      { date: '2026-08-08', usageGB: 20.85, isCorrected: false, rawMessage: "Y'ello, your data usage for 08-08-2026 is 20.85GB." },
      { date: '2026-08-09', usageGB: 27.33, isCorrected: false, rawMessage: "Y'ello, your data usage for 09-08-2026 is 27.33GB." },
      { date: '2026-08-10', usageGB: 35.47, isCorrected: false, rawMessage: "Y'ello, your data usage for 10-08-2026 is 35.47GB." },
      { date: '2026-08-11', usageGB: 19.82, isCorrected: true, rawMessage: "Y'ello, your corrected data usage for 11-08-2026 is 19.82GB." },
      { date: '2026-08-12', usageGB: 19.56, isCorrected: false, rawMessage: "Y'ello, your data usage for 12-08-2026 is 19.56GB." }
    ]
  }, null, 2));
}

// Helper to parse MTNN SMS text
function parseMtnnSmsText(text) {
  const records = [];
  const regex = /Y'?ello,?\s*(?:your\s*)?(corrected\s*)?data\s*usage\s*for\s*(\d{2}-\d{2}-\d{4})\s*is\s*([\d\.]+)\s*(GB|MB|KB)/gi;
  
  let match;
  while ((match = regex.exec(text)) !== null) {
    const isCorrected = !!match[1];
    const dateStr = match[2]; // DD-MM-YYYY
    const value = parseFloat(match[3]);
    const unit = match[4] ? match[4].toUpperCase() : 'GB';
    
    let usageGB = value;
    if (unit === 'MB') usageGB = value / 1024;
    if (unit === 'KB') usageGB = value / (1024 * 1024);
    
    const parts = dateStr.split('-');
    const formattedDate = `${parts[2]}-${parts[1]}-${parts[0]}`;
    
    records.push({
      date: formattedDate,
      usageGB: parseFloat(usageGB.toFixed(2)),
      isCorrected: isCorrected,
      rawMessage: match[0]
    });
  }
  return records;
}

// Save records cleanly to DB
function saveRecords(newRecords, boardType = null) {
  const data = JSON.parse(fs.readFileSync(DB_FILE, 'utf-8'));
  const map = new Map();
  
  if (boardType) {
    data.settings.detectedModel = boardType;
    const isOduOrFibre = /X17U|ODU|Fibre|X28/i.test(boardType);
    if (isOduOrFibre && data.settings.isUnlimited === undefined) {
      data.settings.isUnlimited = true;
    }
  }

  data.records.forEach(r => map.set(r.date, r));
  
  newRecords.forEach(nr => {
    if (!map.has(nr.date) || nr.isCorrected || !map.get(nr.date).isCorrected) {
      map.set(nr.date, nr);
    }
  });
  
  data.records = Array.from(map.values()).sort((a, b) => a.date.localeCompare(b.date));
  fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
  return data;
}

// REST Endpoints
app.get('/api/history', (req, res) => {
  const data = JSON.parse(fs.readFileSync(DB_FILE, 'utf-8'));
  res.json(data);
});

app.get('/api/ping', (req, res) => {
  const start = Date.now();
  fetch(`http://${ROUTER_IP}/cgi-bin/http.cgi`, { method: 'HEAD' })
    .then(() => res.json({ status: 'online', latencyMs: Date.now() - start }))
    .catch(() => res.json({ status: 'offline', latencyMs: -1 }));
});

// WAN Byte counter parser fallback for routers without daily SMS
function parseWanByteCounters(wanData) {
  if (!wanData || (!wanData.rx_bytes && !wanData.tx_bytes)) return null;
  const rx = parseFloat(wanData.rx_bytes || 0);
  const tx = parseFloat(wanData.tx_bytes || 0);
  const totalBytes = rx + tx;
  const usageGB = parseFloat((totalBytes / (1024 * 1024 * 1024)).toFixed(2));
  const today = new Date().toISOString().substring(0, 10);
  return {
    date: today,
    usageGB: usageGB,
    isCorrected: false,
    rawMessage: `Router Interface Counter: ${usageGB} GB (RX: ${(rx/(1024*1024*1024)).toFixed(2)}GB, TX: ${(tx/(1024*1024*1024)).toFixed(2)}GB)`
  };
}

app.post('/api/parse-sms', (req, res) => {
  const { text } = req.body;
  if (!text) return res.status(400).json({ error: 'Text required' });
  const parsed = parseMtnnSmsText(text);
  const updatedData = saveRecords(parsed);
  res.json({ count: parsed.length, data: updatedData });
});

app.get('/api/export-csv', (req, res) => {
  const data = JSON.parse(fs.readFileSync(DB_FILE, 'utf-8'));
  let csv = 'Date,Usage_GB,Status,Raw_Message\n';
  data.records.forEach(r => {
    csv += `"${r.date}",${r.usageGB},"${r.isCorrected ? 'Corrected' : 'Daily Summary'}","${r.rawMessage.replace(/"/g, '""')}"\n`;
  });
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename=mtn_odu_data_history.csv');
  res.send(csv);
});

app.post('/api/settings', (req, res) => {
  const { monthlyLimitGB, cycleStartDay, isUnlimited } = req.body;
  const data = JSON.parse(fs.readFileSync(DB_FILE, 'utf-8'));
  data.settings = {
    monthlyLimitGB: parseFloat(monthlyLimitGB) || 1000,
    cycleStartDay: parseInt(cycleStartDay) || 1,
    isUnlimited: !!isUnlimited
  };
  fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
  res.json(data);
});

// Helper function for background router sync
async function performRouterSync(password = 'admin', routerIp = '192.168.0.1') {
  const cleanIp = (routerIp || ROUTER_IP).replace(/^https?:\/\//i, '').replace(/\/.*$/, '').trim();
  const httpUrl = `http://${cleanIp}/cgi-bin/http.cgi`;
  
  // Step 1: Safe Token Retrieval
  const tokenRes = await fetch(httpUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cmd: 232, method: 'GET', sessionId: '' })
  });
  
  const textBody = await tokenRes.text();
  if (textBody.trim().startsWith('<')) {
    throw new Error(`Device at ${cleanIp} returned HTML (Not ZLT API). Ensure router IP is correct or paste SMS text.`);
  }

  let tokenData;
  try {
    tokenData = JSON.parse(textBody);
  } catch (e) {
    throw new Error(`Invalid JSON response from router at ${cleanIp}.`);
  }

  const token = tokenData?.token || tokenData?.data?.token;
  if (!token) throw new Error(`Could not retrieve security token from ${cleanIp}`);

  // Step 2: Hash Password & Login
  const passwdHash = crypto.createHash('sha256').update(token + password).digest('hex');
  const sessionId = crypto.createHash('md5').update(Math.random().toString()).digest('hex');

  const loginRes = await fetch(httpUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cmd: 100, method: 'POST', username: 'admin', passwd: passwdHash, sessionId, isAutoUpgrade: '1', isCheckPasswd: '1' })
  });
  
  const loginText = await loginRes.text();
  if (loginText.trim().startsWith('<')) {
    throw new Error(`Login endpoint returned HTML page.`);
  }

  const loginData = JSON.parse(loginText);
  if (loginData.login_fail === 'fail') throw new Error('Router password incorrect.');

  const activeSessionId = loginData.sessionId || sessionId;

  // Step 3: Refresh Session Token
  let activeToken = token;
  try {
    const tokRes = await fetch(httpUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cmd: 233, method: 'GET', sessionId: activeSessionId })
    });
    const tokData = await tokRes.json();
    if (tokData?.token) activeToken = tokData.token;
  } catch (e) {}

  // Step 4: Detect Device Model (cmd: 1005)
  let boardType = (cleanIp === '192.168.0.1' || !cleanIp) ? 'MTN 5G ODU • ZLT X17U' : (cleanIp.includes('8.1') ? 'MTN Broadband 4G MiFi' : 'MTN Broadband Gateway');
  try {
    const devRes = await fetch(httpUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cmd: 1005, method: 'GET', sessionId: activeSessionId, token: activeToken })
    });
    const devData = await devRes.json();
    const rawModel = devData?.board_type || devData?.model_name || devData?.product_name || devData?.model;
    if (rawModel) {
      if (/X17U|ODU/i.test(rawModel)) boardType = 'MTN 5G ODU • ZLT X17U';
      else if (/X28/i.test(rawModel)) boardType = 'MTN 5G ODU • ZLT X28';
      else if (/Fibre/i.test(rawModel)) boardType = `MTN FibreX • ${rawModel}`;
      else boardType = rawModel;
    }
  } catch (e) {}

  // Step 5: Fetch & Decode Multi-Page SMS Inbox (Pages 1 to 3)
  let combinedText = '';
  for (let page = 1; page <= 3; page++) {
    try {
      const smsRes = await fetch(httpUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cmd: 12, method: 'GET', page_num: page, subcmd: 0, sessionId: activeSessionId, token: activeToken })
      });
      const smsData = await smsRes.json();
      const rawList = typeof smsData?.sms_list === 'string' ? smsData.sms_list.split(',') : (smsData?.sms_list || []);
      rawList.forEach(item => {
        try {
          combinedText += '\n' + Buffer.from(item.trim(), 'base64').toString('utf-8');
        } catch (e) {
          if (typeof item === 'string') combinedText += '\n' + item;
        }
      });
    } catch (e) {}
  }

  const parsed = parseMtnnSmsText(combinedText);
  return { records: parsed, detectedModel: boardType };
}

// Auto-sync router SMS endpoint
app.post('/api/sync-router', async (req, res) => {
  const { password, routerIp } = req.body;
  try {
    const result = await performRouterSync(password || 'admin', routerIp || '192.168.0.1');
    res.json({ success: true, parsedCount: result.records.length, records: result.records, detectedModel: result.detectedModel });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Schedule automatic sync daily at Midnight (12:00 AM)
function scheduleMidnightSync() {
  const now = new Date();
  const nextMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0);
  const msUntilMidnight = nextMidnight.getTime() - now.getTime();

  setTimeout(async () => {
    try {
      await performRouterSync('admin');
      console.log('[AUTO-SYNC] Midnight automated sync completed successfully.');
    } catch (err) {
      console.log('[AUTO-SYNC] Midnight check:', err.message);
    }
    scheduleMidnightSync();
  }, msUntilMidnight);
}

scheduleMidnightSync();

const server = app.listen(PORT, () => {
  console.log(`MTN ODU Data Tracker Server running on http://localhost:${PORT}`);
  performRouterSync('admin').then(() => {
    console.log('[AUTO-SYNC] Initial startup sync completed.');
  }).catch(() => {});
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    const ALT_PORT = Number(PORT) + 1;
    console.log(`Port ${PORT} is busy, starting on http://localhost:${ALT_PORT}...`);
    app.listen(ALT_PORT);
  }
});
