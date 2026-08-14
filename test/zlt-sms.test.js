'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createZltSmsCollector } = require('../src/collectors/zlt-sms');

function jsonResponse(body) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' }
  });
}

function encodedSms(text) {
  return Buffer.from(text, 'utf8').toString('base64');
}

test('ZLT SMS collector reads usage messages across three inbox pages', async () => {
  const pages = [
    [encodedSms("Y'ello, your data usage for 14-08-2026 is 1.50GB.")],
    [encodedSms("Y'ello, your data usage for 13-08-2026 is 512MB.")],
    [encodedSms("Y'ello, your corrected data usage for 12-08-2026 is 0.75GB.")]
  ];
  const pageRequests = [];

  const fetchImpl = async (url, options = {}) => {
    const body = JSON.parse(options.body);
    if (body.cmd === 232) return jsonResponse({ token: 'token-1' });
    if (body.cmd === 100) return jsonResponse({ sessionId: 'session-1' });
    if (body.cmd === 233) return jsonResponse({ token: 'token-2' });
    if (body.cmd === 1005) return jsonResponse({ board_type: 'ZLT X17U' });
    if (body.cmd === 12) {
      pageRequests.push(body.page_num);
      return jsonResponse({ sms_list: pages[body.page_num - 1] || [] });
    }
    throw new Error(`Unexpected command: ${body.cmd}`);
  };

  const collector = createZltSmsCollector({ fetchImpl });
  const result = await collector.collect({
    routerIp: '192.168.0.1',
    password: 'test-password'
  });

  assert.deepEqual(pageRequests, [1, 2, 3]);
  assert.equal(result.records.length, 3);
  assert.deepEqual(result.records.map(record => record.date), [
    '2026-08-14',
    '2026-08-13',
    '2026-08-12'
  ]);
  assert.equal(result.records[1].usageGB, 0.5);
  assert.equal(result.records[2].isCorrected, true);
});
