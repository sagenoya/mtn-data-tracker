'use strict';

const cors = require('cors');
const express = require('express');
const fs = require('fs');
const path = require('path');

const { createCollectorRegistry } = require('./collectors/registry');
const { JsonStore } = require('./storage/json-store');
const { SyncService } = require('./services/sync-service');
const { upsertSource, upsertUsageRecords } = require('./domain/schema');

function cleanRouterIp(routerIp) {
  return (routerIp || '').replace(/^https?:\/\//i, '').replace(/\/.*$/, '').trim();
}

function isPrivateRouterIp(routerIp) {
  return /^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(cleanRouterIp(routerIp));
}

function fetchWithTimeout(url, options = {}, timeoutMs = 5000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...options, signal: controller.signal })
    .finally(() => clearTimeout(timeout));
}

function csvCell(value) {
  return `"${String(value ?? '').replace(/"/g, '""')}"`;
}

function createApplication({
  dbFile = path.join(__dirname, '..', 'data_history.json'),
  publicDir = path.join(__dirname, '..', 'public'),
  routerIp = process.env.ROUTER_IP || '192.168.0.1',
  routerPassword = process.env.ROUTER_PASSWORD || '',
  allowPrivateRouterSync = true,
  collectors = []
} = {}) {
  const store = new JsonStore(dbFile);
  const registry = createCollectorRegistry({ collectors });
  const syncService = new SyncService({
    store,
    registry,
    defaultRouterIp: routerIp,
    defaultRouterPassword: routerPassword
  });
  const app = express();

  app.disable('x-powered-by');
  app.use(cors());
  app.use(express.json({ limit: '1mb' }));
  if (publicDir && fs.existsSync(publicDir)) app.use(express.static(publicDir));

  app.get('/api/config', (req, res) => {
    res.json({
      schemaVersion: 1,
      defaultRouterIp: routerIp,
      defaultCollectorId: 'auto',
      autoSyncEnabled: Boolean(routerPassword),
      autoSyncIntervalMinutes: Number(process.env.AUTO_SYNC_INTERVAL_MINUTES || 5),
      storage: 'json-store',
      dataAuthority: allowPrivateRouterSync ? 'local-service' : 'browser'
    });
  });

  app.get('/api/collectors', (req, res) => {
    res.json({ schemaVersion: 1, collectors: registry.list() });
  });

  app.get('/api/history', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json(syncService.getState());
  });

  app.get('/api/status', (req, res) => {
    const state = syncService.getState();
    res.json({
      schemaVersion: state.schemaVersion,
      lastSync: state.lastSync,
      sources: state.sources,
      events: state.events.slice(-20),
      accounting: Object.values(state.accounting).map(account => ({
        sourceId: account.sourceId,
        routerIp: account.routerIp,
        epochId: account.epochId,
        lastStatus: account.lastStatus,
        lastSeenAt: account.lastSeenAt,
        lastObservation: account.lastObservation
      }))
    });
  });

  async function syncRoute(req, res) {
    const { collectorId = 'auto', password, routerIp: requestedIp, inputText } = req.body || {};
    const targetIp = cleanRouterIp(requestedIp || routerIp);
    if (!inputText && !allowPrivateRouterSync && isPrivateRouterIp(targetIp)) {
      return res.status(400).json({
        error: 'Cloud servers cannot reach private router IPs. Run the local collector instead.'
      });
    }

    try {
      const result = await syncService.sync({
        collectorId,
        password,
        routerIp: targetIp,
        inputText
      });
      return res.json(result);
    } catch (error) {
      return res.status(500).json({ error: error.message });
    }
  }

  app.post('/api/sync', syncRoute);
  app.post('/api/sync-router', syncRoute);

  app.post('/api/parse-sms', async (req, res) => {
    const { text } = req.body || {};
    if (!text) return res.status(400).json({ error: 'Text required' });
    try {
      const result = await syncService.importSms(text);
      return res.json({ count: result.sync.recordsIngested, ...result });
    } catch (error) {
      return res.status(400).json({ error: error.message });
    }
  });

  app.get('/api/ping', (req, res) => {
    const targetIp = cleanRouterIp(req.query.routerIp || routerIp);
    const start = Date.now();
    fetchWithTimeout(`http://${targetIp}/`)
      .then(response => res.json({
        status: response.ok ? 'online' : 'offline',
        latencyMs: Date.now() - start,
        routerIp: targetIp
      }))
      .catch(() => res.json({ status: 'offline', latencyMs: -1, routerIp: targetIp }));
  });

  app.get('/api/export-csv', (req, res) => {
    const state = syncService.getState();
    const rows = [
      ['Date', 'Usage_GB', 'Download_GB', 'Upload_GB', 'Source', 'Confidence', 'Status', 'Raw_Message']
    ];
    state.records.forEach(record => rows.push([
      record.date,
      record.usageGB,
      record.downloadBytes === null ? '' : (record.downloadBytes / (1024 * 1024 * 1024)).toFixed(2),
      record.uploadBytes === null ? '' : (record.uploadBytes / (1024 * 1024 * 1024)).toFixed(2),
      record.sourceLabel,
      record.confidence,
      record.isCorrected ? 'Corrected' : 'Daily Summary',
      record.rawMessage
    ]));
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename=wifiwatch_usage_history.csv');
    res.send(rows.map(row => row.map(csvCell).join(',')).join('\n'));
  });

  app.get('/api/backup', (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename=wifiwatch_backup_${new Date().toISOString().substring(0, 10)}.json`);
    res.json(syncService.getState());
  });

  app.post('/api/restore', (req, res) => {
    try {
      const backupData = req.body;
      if (!backupData || !Array.isArray(backupData.records)) {
        return res.status(400).json({ error: 'Invalid backup format' });
      }
      const state = store.update(current => {
        const incoming = backupData.recordVariants?.length ? backupData.recordVariants : backupData.records;
        const source = { id: 'backup-restore', label: 'Backup Restore', kind: 'imported' };
        upsertSource(current, source);
        upsertUsageRecords(current, incoming, source);
        if (backupData.settings) {
          current.settings = { ...current.settings, ...backupData.settings };
        }
        return current;
      });
      return res.json({ success: true, count: state.records.length, data: state });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/settings', (req, res) => {
    const { monthlyLimitGB, cycleStartDay, isUnlimited } = req.body || {};
    const state = store.update(current => {
      current.settings = {
        ...current.settings,
        monthlyLimitGB: Number(monthlyLimitGB) || 1000,
        cycleStartDay: Number(cycleStartDay) || 1,
        isUnlimited: Boolean(isUnlimited)
      };
      return current;
    });
    res.json(state);
  });

  return {
    app,
    store,
    registry,
    syncService
  };
}

module.exports = {
  createApplication,
  isPrivateRouterIp
};
