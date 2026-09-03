'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { createApplication } = require('../src/app');

async function startApplication(options) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wifiwatch-app-'));
  const { app } = createApplication({
    ...options,
    dbFile: path.join(directory, 'history.json'),
    publicDir: null
  });
  const server = await new Promise(resolve => {
    const instance = app.listen(0, () => resolve(instance));
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  return { baseUrl, server, directory };
}

test('application advertises the correct storage authority for local and hosted modes', async t => {
  const local = await startApplication({ allowPrivateRouterSync: true });
  const hosted = await startApplication({ allowPrivateRouterSync: false });
  t.after(async () => {
    await Promise.all([
      new Promise(resolve => local.server.close(resolve)),
      new Promise(resolve => hosted.server.close(resolve))
    ]);
    fs.rmSync(local.directory, { recursive: true, force: true });
    fs.rmSync(hosted.directory, { recursive: true, force: true });
  });

  const localConfig = await fetch(`${local.baseUrl}/api/config`).then(response => response.json());
  const hostedConfig = await fetch(`${hosted.baseUrl}/api/config`).then(response => response.json());
  const hostedHistory = await fetch(`${hosted.baseUrl}/api/history`).then(response => response.json());
  const hostedSync = await fetch(`${hosted.baseUrl}/api/sync-router`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ routerIp: '192.168.1.1', password: 'test-only' })
  });

  assert.equal(localConfig.dataAuthority, 'local-service');
  assert.equal(hostedConfig.dataAuthority, 'browser');
  assert.equal(hostedHistory.schemaVersion, 1);
  assert.equal(hostedHistory.records.length, 0);
  assert.equal(hostedSync.status, 400);

  const restoreRes = await fetch(`${local.baseUrl}/api/restore`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      records: [
        { date: '2026-08-01', usageGB: 12.5, usageBytes: 13421772800 },
        { date: '2026-08-02', usageGB: 10.0, usageBytes: 10737418240 }
      ]
    })
  });
  const restoreJson = await restoreRes.json();
  assert.equal(restoreJson.success, true);
  assert.equal(restoreJson.count, 2);

  const backupRes = await fetch(`${local.baseUrl}/api/backup`).then(r => r.json());
  assert.equal(backupRes.records.length, 2);
});

