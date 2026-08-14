'use strict';

const crypto = require('crypto');

const DEFAULT_TIMEOUT_MS = 10000;

const ZTE_SOURCE = {
  id: 'zte-f6600p',
  label: 'MTN FibreX • ZTE F6600P',
  kind: 'router-counter',
  model: 'ZTE F6600P',
  capabilities: {
    historical: false,
    liveSnapshot: true,
    cumulativeCounters: true,
    resetDetection: true,
    dailyRecords: true
  }
};

function cleanRouterIp(routerIp) {
  return (routerIp || '').replace(/^https?:\/\//i, '').replace(/\/.*$/, '').trim();
}

function createTimeoutFetch(fetchImpl, timeoutMs) {
  return (url, options = {}, customTimeout = timeoutMs) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), customTimeout);
    return fetchImpl(url, { ...options, signal: controller.signal })
      .finally(() => clearTimeout(timeout));
  };
}

function updateCookieJar(response, cookieJar) {
  const getSetCookie = response.headers.getSetCookie;
  const rawCookies = typeof getSetCookie === 'function'
    ? getSetCookie.call(response.headers)
    : (response.headers.get('set-cookie') || '').split(/,(?=\s*[^;,=]+=)/);

  rawCookies.filter(Boolean).forEach(cookie => {
    const pair = cookie.split(';', 1)[0];
    const separator = pair.indexOf('=');
    if (separator > 0) cookieJar[pair.substring(0, separator)] = pair.substring(separator + 1);
  });
}

function cookieHeader(cookieJar) {
  return Object.entries(cookieJar)
    .map(([key, value]) => `${key}=${value}`)
    .join('; ');
}

function parseZteParameters(xml) {
  const values = {};
  const pairRegex = /<ParaName>\s*([^<]+?)\s*<\/ParaName>\s*<ParaValue>([\s\S]*?)<\/ParaValue>/gi;
  let match;
  while ((match = pairRegex.exec(xml)) !== null) {
    values[match[1].trim()] = match[2].replace(/<[^>]+>/g, '').trim();
  }
  return values;
}

function looksLikeZteGateway(body) {
  return /F6600P|_type=loginData&_tag=login_entry|ZTE Corporation/i.test(body);
}

function createZteSource(routerIp) {
  return { ...ZTE_SOURCE, routerIp };
}

function createZteF6600PCollector({ fetchImpl = global.fetch, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('A fetch implementation is required for the ZTE collector.');
  const fetchWithTimeout = createTimeoutFetch(fetchImpl, timeoutMs);

  async function request(cleanIp, cookieJar, pathName, options = {}) {
    const headers = {
      'User-Agent': 'WiFiWatch-local-ZTE-collector/1.0',
      'X-Requested-With': 'XMLHttpRequest',
      ...(options.headers || {})
    };
    const cookies = cookieHeader(cookieJar);
    if (cookies) headers.Cookie = cookies;

    const response = await fetchWithTimeout(`http://${cleanIp}${pathName}`, {
      ...options,
      headers
    });
    updateCookieJar(response, cookieJar);
    return { response, text: await response.text() };
  }

  return {
    id: ZTE_SOURCE.id,
    label: ZTE_SOURCE.label,
    kind: ZTE_SOURCE.kind,
    model: ZTE_SOURCE.model,
    capabilities: ZTE_SOURCE.capabilities,

    async probe({ routerIp }) {
      const cleanIp = cleanRouterIp(routerIp);
      if (!cleanIp) return { matched: false };
      try {
        const response = await fetchWithTimeout(`http://${cleanIp}/`, {
          headers: { 'User-Agent': 'WiFiWatch-router-probe/1.0' }
        }, 5000);
        const body = await response.text();
        return { matched: looksLikeZteGateway(body), model: looksLikeZteGateway(body) ? 'ZTE F6600P' : null };
      } catch (error) {
        return { matched: false, error: error.message };
      }
    },

    async collect({ routerIp, password }) {
      const cleanIp = cleanRouterIp(routerIp);
      if (!cleanIp) throw new Error('A router IP address is required for the ZTE collector.');
      if (!password) throw new Error('A router admin password is required for the ZTE collector.');

      const source = createZteSource(cleanIp);
      const cookieJar = {};
      const loginEntry = await request(cleanIp, cookieJar, '/?_type=loginData&_tag=login_entry');
      let loginState;
      try {
        loginState = JSON.parse(loginEntry.text);
      } catch (error) {
        throw new Error(`ZTE router at ${cleanIp} did not return a login session.`);
      }

      const challengeResponse = await request(cleanIp, cookieJar, '/?_type=loginData&_tag=login_token');
      const challengeMatch = challengeResponse.text.match(/>\s*([^<]+?)\s*</);
      const challenge = challengeMatch?.[1]?.trim();
      if (!challenge) throw new Error(`ZTE router at ${cleanIp} did not return a login challenge.`);

      const passwordHash = crypto.createHash('sha256').update(password + challenge).digest('hex');
      const loginResult = await request(cleanIp, cookieJar, '/?_type=loginData&_tag=login_entry', {
        method: 'POST',
        body: new URLSearchParams({
          action: 'login',
          Password: passwordHash,
          Username: 'admin',
          _sessionTOKEN: loginState?.sess_token || ''
        })
      });

      let loginData;
      try {
        loginData = JSON.parse(loginResult.text);
      } catch (error) {
        throw new Error('ZTE login returned an invalid response.');
      }
      if (!loginData?.sess_token || loginData.loginErrMsg) {
        throw new Error(loginData?.loginErrMsg || 'ZTE router password incorrect.');
      }

      await request(cleanIp, cookieJar, '/');
      const statusPage = await request(cleanIp, cookieJar, '/?_type=menuView&_tag=ethWanStatus&Menu3Location=0');
      if (/SessionTimeout/i.test(statusPage.text)) {
        throw new Error('ZTE session expired before WAN status could be read.');
      }

      const wanData = await request(cleanIp, cookieJar, '/?_type=menuData&_tag=wan_internetstatus_lua.lua&TypeUplink=2&pageType=1');
      const params = parseZteParameters(wanData.text);
      const rxBytes = Number(params.RxBytes);
      const txBytes = Number(params.TxBytes);
      if (!Number.isFinite(rxBytes) || !Number.isFinite(txBytes)) {
        throw new Error(`ZTE WAN counters were not available at ${cleanIp}.`);
      }

      const observedAt = new Date().toISOString();
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
          rxBytes,
          txBytes,
          downloadBytes: rxBytes,
          uploadBytes: txBytes,
          totalBytes: rxBytes + txBytes,
          uptimeSeconds: Number.isFinite(Number(params.UpTime)) ? Number(params.UpTime) : null,
          connectionStatus: params.ConnStatus || 'Unknown',
          counterScope: 'wan'
        }],
        counterStatus: 'snapshot'
      };
    }
  };
}

module.exports = {
  ZTE_SOURCE,
  cleanRouterIp,
  createZteF6600PCollector,
  looksLikeZteGateway,
  parseZteParameters
};
