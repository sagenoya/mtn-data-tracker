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

function saveRecords(newRecords) {
  const data = getDbData();
  const map = new Map();
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

// REST Endpoints
app.get('/api/history', (req, res) => {
  res.json(getDbData());
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
