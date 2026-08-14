'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { parseMtnUsageSms } = require('../src/collectors/sms');

test('SMS collector returns normalized provider records', () => {
  const records = parseMtnUsageSms(
    "Y'ello, your data usage for 14-08-2026 is 1.50GB.\n" +
    "Y'ello, your corrected data usage for 13-08-2026 is 512MB."
  );

  assert.equal(records.length, 2);
  assert.equal(records[0].date, '2026-08-14');
  assert.equal(records[0].usageGB, 1.5);
  assert.equal(records[0].sourceType, 'provider-sms');
  assert.equal(records[1].isCorrected, true);
  assert.equal(records[1].usageGB, 0.5);
});
