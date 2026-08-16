'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const { createZteUbusCollector, looksLikeZteUbusGateway } = require('../src/collectors/zte-ubus');

const SALT = 'C077A29D57A7AA923CF2049B761A28070D379643EF8E2F480B7B684786CF486D';
const PASSWORD = 'admin';

function expectedPasswordHash(password, salt) {
  const hash1 = crypto.createHash('sha256').update(password).digest('hex').toUpperCase();
  return crypto.createHash('sha256').update(hash1 + salt).digest('hex').toUpperCase();
}

function jsonRpcResponse(result, headers = {}) {
  return new Response(JSON.stringify([{ jsonrpc: '2.0', id: 1, result }]), {
    status: 200,
    headers: { 'content-type': 'application/json', ...headers }
  });
}

test('looksLikeZteUbusGateway detects the zwrt_web signature', () => {
  assert.equal(looksLikeZteUbusGateway('<script>var x = "zwrt_web";</script>'), true);
  assert.equal(looksLikeZteUbusGateway('<html>some other router</html>'), false);
  assert.equal(looksLikeZteUbusGateway(''), false);
});

test('ZTE ubus collector probe recognizes the router signature', async () => {
  const fetchImpl = async () => new Response('<html>...zwrt_web...</html>', {
    status: 200,
    headers: { 'content-type': 'text/html' }
  });
  const collector = createZteUbusCollector({ fetchImpl });
  const result = await collector.probe({ routerIp: '192.168.0.1' });
  assert.equal(result.matched, true);
});

test('ZTE ubus collector logs in with salted SHA256 and returns WAN counters', async () => {
  const calls = [];

  const fetchImpl = async (url, options = {}) => {
    const body = JSON.parse(options.body)[0];
    const [, obj, method, params] = body.params;
    calls.push(`${obj}.${method}`);

    assert.equal(options.headers.Referer, 'http://192.168.0.1/');
    assert.equal(options.headers.Origin, 'http://192.168.0.1');
    assert.equal(options.headers['X-Requested-With'], 'XMLHttpRequest');

    if (obj === 'zwrt_web' && method === 'web_login_info') {
      return jsonRpcResponse([0, { zte_web_sault: SALT, login_fail_num: 5 }], {
        'set-cookie': 'webtoken="abc123";path=/;HttpOnly'
      });
    }
    if (obj === 'zwrt_web' && method === 'web_login') {
      assert.equal(options.headers.Cookie, 'webtoken="abc123"');
      assert.equal(params.password, expectedPasswordHash(PASSWORD, SALT));
      return jsonRpcResponse([0, { result: 0, ubus_rpc_session: 'session-token-123' }]);
    }
    if (obj === 'zwrt_data' && method === 'get_wwandst') {
      assert.equal(options.headers.Cookie, 'webtoken="abc123"');
      return jsonRpcResponse([0, {
        real_rx_bytes: 3564000000,
        real_tx_bytes: 365000000,
        month_rx_bytes: 40000000000,
        month_tx_bytes: 5000000000
      }]);
    }
    throw new Error(`Unexpected ubus call: ${obj}.${method}`);
  };

  const collector = createZteUbusCollector({ fetchImpl });
  const result = await collector.collect({ routerIp: '192.168.0.1', password: PASSWORD });
  const snapshot = result.snapshots[0];

  assert.deepEqual(calls, ['zwrt_web.web_login_info', 'zwrt_web.web_login', 'zwrt_data.get_wwandst']);
  assert.equal(snapshot.downloadBytes, 3564000000);
  assert.equal(snapshot.uploadBytes, 365000000);
  assert.equal(snapshot.totalBytes, 3929000000);
  assert.equal(snapshot.counterScope, 'wan');
  assert.equal(result.source.id, 'zte-ubus');
});

test('ZTE ubus collector rejects an incorrect password', async () => {
  const fetchImpl = async (url, options = {}) => {
    const body = JSON.parse(options.body)[0];
    const [, obj, method] = body.params;
    if (obj === 'zwrt_web' && method === 'web_login_info') {
      return jsonRpcResponse([0, { zte_web_sault: SALT }]);
    }
    if (obj === 'zwrt_web' && method === 'web_login') {
      return jsonRpcResponse([0, { result: 1, msg: 'login fail.', login_fail_num: 4 }]);
    }
    throw new Error(`Unexpected ubus call: ${obj}.${method}`);
  };

  const collector = createZteUbusCollector({ fetchImpl });
  await assert.rejects(
    () => collector.collect({ routerIp: '192.168.0.1', password: 'wrong-password' }),
    /incorrect/i
  );
});
