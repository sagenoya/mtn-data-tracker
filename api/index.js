const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
const DB_FILE = '/tmp/data_history.json';
const ROUTER_IP = '192.168.0.1';

app.use(cors());
app.use(express.json());

// Initialize DB in /tmp for Vercel Serverless environment
function getDbData() {
  const localDbPath = path.join(__dirname, '..', 'data_history.json');
  if (!fs.existsSync(DB_FILE)) {
    if (fs.existsSync(localDbPath)) {
      fs.copyFileSync(localDbPath, DB_FILE);
    } else {
      fs.writeFileSync(DB_FILE, JSON.stringify({
        settings: { monthlyLimitGB: 1000, cycleStartDay: 1, isUnlimited: true },
        records: []
      }, null, 2));
    }
  }
  return JSON.parse(fs.readFileSync(DB_FILE, 'utf-8'));
}

function saveDbData(data) {
  fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
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

function saveRecords(newRecords, boardType = null) {
  const data = getDbData();
  const map = new Map();
  if (boardType) data.settings.detectedModel = boardType;
  data.records.forEach(r => map.set(r.date, r));
  newRecords.forEach(nr => {
    if (!map.has(nr.date) || nr.isCorrected || !map.get(nr.date).isCorrected) {
      map.set(nr.date, nr);
    }
  });
  data.records = Array.from(map.values()).sort((a, b) => a.date.localeCompare(b.date));
  saveDbData(data);
  return data;
}

// Helper for Vercel cloud router sync (With Private IP check)
async function performVercelRouterSync(password = 'admin', routerIp = '192.168.0.1') {
  const cleanIp = (routerIp || ROUTER_IP).replace(/^https?:\/\//i, '').replace(/\/.*$/, '').trim();
  
  // Private LAN IP Check on Cloud Hosts
  if (/^(192\.168|10\.|172\.(1[6-9]|2[0-9]|3[01]))/.test(cleanIp)) {
    throw new Error(`Cloud Limit: Vercel servers cannot reach private LAN IP (${cleanIp}). Use local app (npm start) for auto-sync.`);
  }

  const httpUrl = `http://${cleanIp}/cgi-bin/http.cgi`;
  
  const tokenRes = await fetch(httpUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cmd: 232, method: 'GET', sessionId: '' })
  });
  
  const textBody = await tokenRes.text();
  if (textBody.trim().startsWith('<')) {
    throw new Error(`Router at ${cleanIp} returned HTML. Verify IP or use local npm start for auto-sync.`);
  }

  const tokenData = JSON.parse(textBody);
  const token = tokenData?.token || tokenData?.data?.token;
  if (!token) throw new Error(`Could not connect to router at ${cleanIp}`);

  const passwdHash = crypto.createHash('sha256').update(token + password).digest('hex');
  const sessionId = crypto.createHash('md5').update(Math.random().toString()).digest('hex');

  const loginRes = await fetch(httpUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cmd: 100, method: 'POST', username: 'admin', passwd: passwdHash, sessionId, isAutoUpgrade: '1', isCheckPasswd: '1' })
  });
  const loginText = await loginRes.text();
  if (loginText.trim().startsWith('<')) throw new Error('Login returned HTML page.');
  
  const loginData = JSON.parse(loginText);
  if (loginData.login_fail === 'fail') throw new Error('Router password incorrect.');

  const activeSessionId = loginData.sessionId || sessionId;

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
      combinedText += '\n' + Buffer.from(item.trim(), 'base64').toString('utf-8');
    } catch (e) {
      if (typeof item === 'string') combinedText += '\n' + item;
    }
  });

  const parsed = parseMtnnSmsText(combinedText);
  return { records: parsed, detectedModel: 'MTN MiFi / Router' };
}

// REST Endpoints
app.get('/api/history', (req, res) => {
  res.json(getDbData());
});

app.post('/api/sync-router', async (req, res) => {
  const { password, routerIp } = req.body;
  try {
    const result = await performVercelRouterSync(password || 'admin', routerIp || '192.168.0.1');
    res.json({ success: true, parsedCount: result.records.length, records: result.records, detectedModel: result.detectedModel });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/parse-sms', (req, res) => {
  const { text } = req.body;
  if (!text) return res.status(400).json({ error: 'Text required' });
  const parsed = parseMtnnSmsText(text);
  const updatedData = saveRecords(parsed);
  res.json({ count: parsed.length, data: updatedData });
});

app.get('/api/export-csv', (req, res) => {
  const data = getDbData();
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
  const data = getDbData();
  data.settings = {
    monthlyLimitGB: parseFloat(monthlyLimitGB) || 1000,
    cycleStartDay: parseInt(cycleStartDay) || 1,
    isUnlimited: !!isUnlimited
  };
  saveDbData(data);
  res.json(data);
});

module.exports = app;
