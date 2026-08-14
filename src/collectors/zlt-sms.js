'use strict';

const crypto = require('crypto');
const { parseMtnUsageSms } = require('./sms');
const { cleanRouterIp } = require('./zte-f6600p');

const DEFAULT_TIMEOUT_MS = 10000;

function createTimeoutFetch(fetchImpl, timeoutMs) {
  return (url, options = {}, customTimeout = timeoutMs) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), customTimeout);
    return fetchImpl(url, { ...options, signal: controller.signal })
      .finally(() => clearTimeout(timeout));
  };
}

function sourceFor(routerIp, model = null) {
  const normalizedModel = /X28/i.test(model || '')
    ? 'MTN 5G ODU • ZLT X28'
    : /X17U|ODU/i.test(model || '') || routerIp === '192.168.0.1'
      ? 'MTN 5G ODU • ZLT X17U'
      : (model || 'MTN Broadband Gateway');

  return {
    id: 'zlt-sms',
    label: normalizedModel,
    kind: 'router-sms',
    model: model || normalizedModel,
    routerIp,
    capabilities: {
      historical: true,
      dailyRecords: true,
      cumulativeCounters: false
    }
  };
}

function createZltSmsCollector({ fetchImpl = global.fetch, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('A fetch implementation is required for the ZLT collector.');
  const fetchWithTimeout = createTimeoutFetch(fetchImpl, timeoutMs);

  async function request(cleanIp, body) {
    return fetchWithTimeout(`http://${cleanIp}/cgi-bin/http.cgi`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
  }

  return {
    id: 'zlt-sms',
    label: 'MTN 5G ODU / ZLT SMS',
    kind: 'router-sms',
    capabilities: {
      historical: true,
      dailyRecords: true,
      cumulativeCounters: false
    },

    async probe({ routerIp }) {
      const cleanIp = cleanRouterIp(routerIp);
      if (!cleanIp) return { matched: false };
      try {
        const response = await request(cleanIp, { cmd: 232, method: 'GET', sessionId: '' });
        const body = await response.text();
        if (body.trim().startsWith('<')) return { matched: false };
        const tokenData = JSON.parse(body);
        return {
          matched: Boolean(tokenData?.token || tokenData?.data?.token),
          model: 'ZLT gateway'
        };
      } catch (error) {
        return { matched: false, error: error.message };
      }
    },

    async collect({ routerIp, password }) {
      const cleanIp = cleanRouterIp(routerIp);
      if (!cleanIp) throw new Error('A router IP address is required for the ZLT collector.');
      if (!password) throw new Error('A router admin password is required for the ZLT collector.');
      const httpUrl = `http://${cleanIp}/cgi-bin/http.cgi`;

      const tokenResponse = await request(cleanIp, { cmd: 232, method: 'GET', sessionId: '' });
      const tokenText = await tokenResponse.text();
      if (tokenText.trim().startsWith('<')) {
        throw new Error(`Device at ${cleanIp} did not expose the ZLT API.`);
      }

      let tokenData;
      try {
        tokenData = JSON.parse(tokenText);
      } catch (error) {
        throw new Error(`Invalid token response from ZLT device at ${cleanIp}.`);
      }
      const token = tokenData?.token || tokenData?.data?.token;
      if (!token) throw new Error(`Could not retrieve a security token from ${cleanIp}.`);

      const passwordHash = crypto.createHash('sha256').update(token + password).digest('hex');
      const sessionId = crypto.createHash('md5').update(Math.random().toString()).digest('hex');
      const loginResponse = await request(cleanIp, {
        cmd: 100,
        method: 'POST',
        username: 'admin',
        passwd: passwordHash,
        sessionId,
        isAutoUpgrade: '1',
        isCheckPasswd: '1'
      });
      const loginText = await loginResponse.text();
      if (loginText.trim().startsWith('<')) throw new Error('ZLT login endpoint returned HTML.');

      const loginData = JSON.parse(loginText);
      if (loginData.login_fail === 'fail') throw new Error('ZLT router password incorrect.');
      const activeSessionId = loginData.sessionId || sessionId;

      let activeToken = token;
      try {
        const tokenResponse = await request(cleanIp, {
          cmd: 233,
          method: 'GET',
          sessionId: activeSessionId
        });
        const refreshed = await tokenResponse.json();
        if (refreshed?.token) activeToken = refreshed.token;
      } catch (error) {
        // Some ZLT firmware versions do not implement the refresh command.
      }

      let model = null;
      try {
        const deviceResponse = await request(cleanIp, {
          cmd: 1005,
          method: 'GET',
          sessionId: activeSessionId,
          token: activeToken
        });
        const deviceData = await deviceResponse.json();
        model = deviceData?.board_type || deviceData?.model_name || deviceData?.product_name || deviceData?.model || null;
      } catch (error) {
        // Model metadata is optional; the SMS usage data is still useful.
      }

      const smsResponse = await request(cleanIp, {
        cmd: 12,
        method: 'GET',
        page_num: 1,
        subcmd: 0,
        sessionId: activeSessionId,
        token: activeToken
      });
      const smsData = await smsResponse.json();
      const rawList = typeof smsData?.sms_list === 'string'
        ? smsData.sms_list.split(',')
        : (smsData?.sms_list || []);

      let combinedText = '';
      rawList.forEach(item => {
        try {
          combinedText += `\n${Buffer.from(String(item).trim(), 'base64').toString('utf8')}`;
        } catch (error) {
          if (typeof item === 'string') combinedText += `\n${item}`;
        }
      });

      const source = sourceFor(cleanIp, model);
      const records = parseMtnUsageSms(combinedText, source);
      return {
        source,
        records,
        snapshots: [],
        counterStatus: 'historical'
      };
    }
  };
}

module.exports = {
  createZltSmsCollector,
  sourceFor
};
