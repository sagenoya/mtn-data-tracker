'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { createApplication } = require('../src/app');

test('a third-party collector can feed the dashboard without dashboard-specific logic', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wifiwatch-plugin-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  const fakeCollector = {
    id: 'demo-provider',
    label: 'Demo provider',
    kind: 'provider-sms',
    capabilities: { historical: true },
    async collect() {
      return {
        source: {
          id: 'demo-provider',
          label: 'Demo provider',
          kind: 'provider-sms',
          capabilities: { historical: true }
        },
        records: [{ date: '2026-08-14', usageGB: 2.5, isCorrected: false }],
        snapshots: [],
        counterStatus: 'historical'
      };
    }
  };

  const { syncService } = createApplication({
    dbFile: path.join(directory, 'history.json'),
    publicDir: null,
    collectors: [fakeCollector]
  });
  const result = await syncService.sync({ collectorId: 'demo-provider' });

  assert.equal(result.success, true);
  assert.equal(result.data.records[0].sourceId, 'demo-provider');
  assert.equal(result.data.records[0].usageGB, 2.5);
  assert.equal(result.sync.status, 'historical');
});
