'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  aggregateZteAccessCounters,
  createZteF6600PCollector,
  parseZteInstances
} = require('../src/collectors/zte-f6600p');

const wlanXml = `
  <ajax_response_xml_root>
    <OBJ_WLANAP_ID>
      <Instance>
        <ParaName>_InstID</ParaName><ParaValue>DEV.WIFI.AP1</ParaValue>
        <ParaName>Enable</ParaName><ParaValue>1</ParaValue>
      </Instance>
      <Instance>
        <ParaName>_InstID</ParaName><ParaValue>DEV.WIFI.AP2</ParaValue>
        <ParaName>Enable</ParaName><ParaValue>0</ParaValue>
      </Instance>
    </OBJ_WLANAP_ID>
    <OBJ_WLANCONFIGDRV_ID>
      <Instance>
        <ParaName>_InstID</ParaName><ParaValue>DEV.WIFI.AP1</ParaValue>
        <ParaName>TotalBytesSent</ParaName><ParaValue>1000</ParaValue>
        <ParaName>TotalBytesReceived</ParaName><ParaValue>200</ParaValue>
      </Instance>
      <Instance>
        <ParaName>_InstID</ParaName><ParaValue>DEV.WIFI.AP2</ParaValue>
        <ParaName>TotalBytesSent</ParaName><ParaValue>9000</ParaValue>
        <ParaName>TotalBytesReceived</ParaName><ParaValue>9000</ParaValue>
      </Instance>
    </OBJ_WLANCONFIGDRV_ID>
  </ajax_response_xml_root>`;

const lanXml = `
  <ajax_response_xml_root>
    <OBJ_PON_PORT_BASIC_STATUS_ID>
      <Instance>
        <ParaName>_InstID</ParaName><ParaValue>DEV.ETH.IF1</ParaValue>
        <ParaName>InBytes</ParaName><ParaValue>300</ParaValue>
        <ParaName>OutBytes</ParaName><ParaValue>400</ParaValue>
      </Instance>
      <Instance>
        <ParaName>_InstID</ParaName><ParaValue>DEV.ETH.IF2</ParaValue>
        <ParaName>InBytes</ParaName><ParaValue>0</ParaValue>
        <ParaName>OutBytes</ParaName><ParaValue>0</ParaValue>
      </Instance>
    </OBJ_PON_PORT_BASIC_STATUS_ID>
  </ajax_response_xml_root>`;

const wanXml = `
  <ajax_response_xml_root>
    <IF_ERRORSTR>SUCC</IF_ERRORSTR>
    <ID_WAN_COMFIG><Instance>
      <ParaName>RxBytes</ParaName><ParaValue>5000</ParaValue>
      <ParaName>TxBytes</ParaName><ParaValue>6000</ParaValue>
      <ParaName>UpTime</ParaName><ParaValue>123</ParaValue>
      <ParaName>ConnStatus</ParaName><ParaValue>Connected</ParaValue>
    </Instance></ID_WAN_COMFIG>
  </ajax_response_xml_root>`;

function response(body, headers = {}) {
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/xml; charset=utf-8', ...headers }
  });
}

test('ZTE access aggregation uses enabled WLAN radios plus all LAN ports', () => {
  const instances = parseZteInstances(wlanXml, 'OBJ_WLANCONFIGDRV_ID');
  assert.equal(instances.length, 2);

  const counters = aggregateZteAccessCounters(wlanXml, lanXml);

  assert.equal(counters.downloadBytes, 1400);
  assert.equal(counters.uploadBytes, 500);
  assert.deepEqual(counters.counterDetails.wlan.enabledAccessPoints, ['DEV.WIFI.AP1']);
  assert.equal(counters.counterDetails.wlan.downloadBytes, 1000);
  assert.equal(counters.counterDetails.lan.downloadBytes, 400);
});

test('ZTE collector reads WAN metadata but returns access-side cumulative counters', async () => {
  const calls = [];
  let loginNumber = 0;
  const fetchImpl = async (url, options = {}) => {
    const requestUrl = new URL(url);
    const path = `${requestUrl.pathname}${requestUrl.search}`;
    calls.push(path);

    if (path === '/?_type=loginData&_tag=login_entry' && !options.method) {
      loginNumber += 1;
      return response(JSON.stringify({ sess_token: `entry-${loginNumber}` }), {
        'content-type': 'application/json',
        'set-cookie': `SID=seed-${loginNumber}; Path=/`
      });
    }
    if (path === '/?_type=loginData&_tag=login_token') {
      return response('<challenge>challenge</challenge>');
    }
    if (path === '/?_type=loginData&_tag=login_entry' && options.method === 'POST') {
      return response(JSON.stringify({ sess_token: `session-${loginNumber}` }), {
        'content-type': 'application/json',
        'set-cookie': `SID=session-${loginNumber}; Path=/`
      });
    }
    if (path === '/') return response('<html>F6600P</html>', { 'content-type': 'text/html' });
    if (path.startsWith('/?_type=menuView')) return response('<div>menu</div>', { 'content-type': 'text/html' });
    if (path.includes('wan_internetstatus_lua.lua')) return response(wanXml);
    if (path.includes('status_lan_info_lua.lua')) return response(lanXml);
    if (path.includes('wlan_wlanstatus_lua.lua')) return response(wlanXml);
    throw new Error(`Unexpected request: ${path}`);
  };

  const collector = createZteF6600PCollector({ fetchImpl });
  const result = await collector.collect({ routerIp: '192.168.1.1', password: 'test-password' });
  const snapshot = result.snapshots[0];

  assert.equal(snapshot.counterScope, 'access');
  assert.equal(snapshot.downloadBytes, 1400);
  assert.equal(snapshot.uploadBytes, 500);
  assert.equal(snapshot.totalBytes, 1900);
  assert.equal(snapshot.uptimeSeconds, 123);
  assert.equal(snapshot.connectionStatus, 'Connected');
  assert.equal(snapshot.counterDetails.wan.downloadBytes, 5000);
  assert.equal(snapshot.counterDetails.wan.uploadBytes, 6000);
  assert.equal(calls.filter(path => path.includes('menuData')).length, 3);
});
