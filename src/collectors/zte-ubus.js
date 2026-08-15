'use strict';

const crypto = require('crypto');
const { cleanRouterIp } = require('./zte-f6600p');

const DEFAULT_TIMEOUT_MS = 10000;

// Anonymous ubus session id, as sent by the router's own web UI before login.
const ANON_SESSION = '00000000000000000000000000000000';

const UBUS_SOURCE = {
  id: 'zte-ubus',
  label: 'MTN 5G ZTE Router • ubus',
  kind: 'router-counter',
  model: 'ZTE ubus (zwrt_web)',
  capabilities: {
    historical: false,
    liveSnapshot: true,
    cumulativeCounters: true,
    resetDetection: true,
    dailyRecords: true,
    counterScope: 'wan'
  }
};

function createTimeoutFetch(fetchImpl, timeoutMs) {
  return (url, options = {}, customTimeout = timeoutMs) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), customTimeout);
    return fetchImpl(url, { ...options, signal: controller.signal })
      .finally(() => clearTimeout(timeout));
  };
}

// Newer ZTE firmware (e.g. units branded "MTN5G") drops the legacy
// /cgi-bin/http.cgi API used by the ZLT collector in favor of a ubus
// JSON-RPC gateway at /ubus/. Its own web UI embeds this exact object/method
// pair when it boots, which makes for a reliable, credential-free signature.
function looksLikeZteUbusGateway(body) {
  return /zwrt_web|\/ubus\/\?t=/i.test(body || '');
}

function extractCookie(response) {
  const raw = response.headers.get('set-cookie');
  if (!raw) return null;
  return raw.split(';')[0];
}

function createUbusSource(routerIp) {
  return { ...UBUS_SOURCE, routerIp };
}

function createZteUbusCollector({ fetchImpl = global.fetch, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('A fetch implementation is required for the ZTE ubus collector.');
  const fetchWithTimeout = createTimeoutFetch(fetchImpl, timeoutMs);

  function headersFor(cleanIp, cookie) {
    const headers = {
      'Content-Type': 'application/json',
      'Referer': `http://${cleanIp}/`,
      'Origin': `http://${cleanIp}`,
      'X-Requested-With': 'XMLHttpRequest'
    };
    if (cookie) headers.Cookie = cookie;
    return headers;
  }

  // The router silently returns an empty body (instead of an error) if the
  // Referer/Origin/X-Requested-With headers above are missing, so this is
  // not optional the way it might look.
  async function ubusCall(cleanIp, headers, sessionId, obj, method, params) {
    const response = await fetchWithTimeout(`http://${cleanIp}/ubus/`, {
      method: 'POST',
      headers,
      body: JSON.stringify([{ jsonrpc: '2.0', id: 1, method: 'call', params: [sessionId, obj, method, params || {}] }])
    });
    const text = await response.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch (error) {
      throw new Error('Ubus endpoint returned a non-JSON response.');
    }
    const entry = json && json[0];
    if (!entry) throw new Error('Empty ubus response.');
    if (entry.error) throw new Error(`Ubus error calling ${obj}.${method}: ${entry.error.message || entry.error.code}`);
    const result = entry.result || [];
    return { data: result[1] || {}, cookie: extractCookie(response) };
  }

  return {
    id: UBUS_SOURCE.id,
    label: UBUS_SOURCE.label,
    kind: UBUS_SOURCE.kind,
    model: UBUS_SOURCE.model,
    capabilities: UBUS_SOURCE.capabilities,

    async probe({ routerIp }) {
      const cleanIp = cleanRouterIp(routerIp);
      if (!cleanIp) return { matched: false };
      try {
        const response = await fetchWithTimeout(`http://${cleanIp}/`, {
          headers: { 'User-Agent': 'WiFiWatch-router-probe/1.0' }
        }, 5000);
        const body = await response.text();
        const matched = looksLikeZteUbusGateway(body);
        return { matched, model: matched ? UBUS_SOURCE.model : null };
      } catch (error) {
        return { matched: false, error: error.message };
      }
    },

    async collect({ routerIp, password }) {
      const cleanIp = cleanRouterIp(routerIp);
      if (!cleanIp) throw new Error('A router IP address is required for the ZTE ubus collector.');
      if (!password) throw new Error('A router admin password is required for the ZTE ubus collector.');

      const infoRes = await ubusCall(cleanIp, headersFor(cleanIp), ANON_SESSION, 'zwrt_web', 'web_login_info', {});
      const salt = infoRes.data.zte_web_sault;
      if (!salt) throw new Error(`Router at ${cleanIp} did not return a login salt (unsupported ubus firmware).`);

      const authedHeaders = headersFor(cleanIp, infoRes.cookie);
      const hash1 = crypto.createHash('sha256').update(password).digest('hex').toUpperCase();
      const hash2 = crypto.createHash('sha256').update(hash1 + salt).digest('hex').toUpperCase();

      const loginRes = await ubusCall(cleanIp, authedHeaders, ANON_SESSION, 'zwrt_web', 'web_login', { password: hash2 });
      if (loginRes.data.result !== 0) throw new Error('ZTE ubus router password incorrect.');

      const session = loginRes.data.ubus_rpc_session;
      const dataRes = await ubusCall(cleanIp, authedHeaders, session, 'zwrt_data', 'get_wwandst', { source_module: 'web', cid: 1, type: 4 });
      const wan = dataRes.data;

      const downloadBytes = Number(wan.real_rx_bytes);
      const uploadBytes = Number(wan.real_tx_bytes);
      if (!Number.isFinite(downloadBytes) || !Number.isFinite(uploadBytes)) {
        throw new Error(`ZTE ubus WAN counters were not available at ${cleanIp}.`);
      }

      const source = createUbusSource(cleanIp);
      const observedAt = new Date().toISOString();
      const monthRxBytes = Number(wan.month_rx_bytes);
      const monthTxBytes = Number(wan.month_tx_bytes);

      return {
        source,
        records: [],
        snapshots: [{
          sourceId: source.id,
          sourceType: source.kind,
          sourceLabel: source.label,
          model: source.model,
          routerIp: cleanIp,
          observedAt,
          rxBytes: downloadBytes,
          txBytes: uploadBytes,
          downloadBytes,
          uploadBytes,
          totalBytes: downloadBytes + uploadBytes,
          uptimeSeconds: null,
          connectionStatus: 'Connected',
          counterScope: 'wan',
          counterDetails: {
            scope: 'wan',
            monthToDate: {
              downloadBytes: Number.isFinite(monthRxBytes) ? monthRxBytes : null,
              uploadBytes: Number.isFinite(monthTxBytes) ? monthTxBytes : null
            }
          }
        }],
        counterStatus: 'snapshot'
      };
    }
  };
}

module.exports = {
  UBUS_SOURCE,
  createZteUbusCollector,
  looksLikeZteUbusGateway
};
