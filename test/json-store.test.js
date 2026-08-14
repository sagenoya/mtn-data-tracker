'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { JsonStore } = require('../src/storage/json-store');

test('JSON store migrates legacy records and counter state into normalized state', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wifiwatch-store-'));
  const filePath = path.join(directory, 'history.json');
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  fs.writeFileSync(filePath, JSON.stringify({
    settings: {
      monthlyLimitGB: 1000,
      cycleStartDay: 1,
      isUnlimited: true,
      detectedModel: 'MTN FibreX • ZTE F6600P',
      zteCounterState: {
        routerIp: '192.168.1.1',
        date: '2026-08-14',
        dayBytes: 500,
        lastTotalBytes: 900,
        lastRxBytes: 300,
        lastTxBytes: 600,
        lastSeenAt: '2026-08-14T10:00:00.000Z'
      }
    },
    records: [{
      date: '2026-08-14',
      usageGB: 0.5,
      isCorrected: false,
      rawMessage: 'legacy record'
    }]
  }));

  const store = new JsonStore(filePath);
  const state = store.read();
  assert.equal(state.schemaVersion, 1);
  assert.equal(state.records.length, 1);
  assert.equal(state.records[0].sourceId, 'legacy-import');
  assert.equal(state.accounting['zte-f6600p'].lastObservation.totalBytes, 900);
  assert.equal(JSON.parse(fs.readFileSync(filePath, 'utf8')).schemaVersion, 1);
});
