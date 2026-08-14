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
    dailyRecords: true,
    counterScope: 'access',
    accessCounters: true
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

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function parseZteInstances(xml, objectId) {
  const escapedObjectId = escapeRegExp(objectId);
  const objectPattern = new RegExp(
    `<${escapedObjectId}\\b[^>]*>([\\s\\S]*?)<\\/${escapedObjectId}>`,
    'i'
  );
  const objectMatch = objectPattern.exec(xml || '');
  if (!objectMatch) return [];

  const instances = [];
  const instanceRegex = /<Instance\b[^>]*>([\s\S]*?)<\/Instance>/gi;
  let instanceMatch;
  while ((instanceMatch = instanceRegex.exec(objectMatch[1])) !== null) {
    instances.push(parseZteParameters(instanceMatch[1]));
  }
  return instances;
}

function nonNegativeNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function sumCounterField(instances, field) {
  return instances.reduce((total, instance) => {
    const value = nonNegativeNumber(instance[field]);
    return total + (value === null ? 0 : value);
  }, 0);
}

function aggregateZteAccessCounters(wlanXml, lanXml) {
  const wlanConfig = parseZteInstances(wlanXml, 'OBJ_WLANAP_ID');
  const wlanStats = parseZteInstances(wlanXml, 'OBJ_WLANCONFIGDRV_ID');
  const lanStats = parseZteInstances(lanXml, 'OBJ_PON_PORT_BASIC_STATUS_ID');
  const enabledWlanIds = new Set(
    wlanConfig
      .filter(instance => instance.Enable === '1')
      .map(instance => instance._InstID)
      .filter(Boolean)
  );
  const selectedWlanStats = wlanStats.filter(instance => (
    enabledWlanIds.size === 0 || enabledWlanIds.has(instance._InstID)
  ));

  const wlanHasCounters = selectedWlanStats.some(instance => (
    nonNegativeNumber(instance.TotalBytesSent) !== null ||
    nonNegativeNumber(instance.TotalBytesReceived) !== null
  ));
  const lanHasCounters = lanStats.some(instance => (
    nonNegativeNumber(instance.InBytes) !== null ||
    nonNegativeNumber(instance.OutBytes) !== null
  ));

  if (!wlanHasCounters || !lanHasCounters) {
    throw new Error('ZTE WLAN/LAN access counters were not available.');
  }

  const wlanDownloadBytes = sumCounterField(selectedWlanStats, 'TotalBytesSent');
  const wlanUploadBytes = sumCounterField(selectedWlanStats, 'TotalBytesReceived');
  const lanDownloadBytes = sumCounterField(lanStats, 'OutBytes');
  const lanUploadBytes = sumCounterField(lanStats, 'InBytes');

  return {
    downloadBytes: wlanDownloadBytes + lanDownloadBytes,
    uploadBytes: wlanUploadBytes + lanUploadBytes,
    counterDetails: {
      scope: 'access',
      wlan: {
        enabledAccessPoints: Array.from(enabledWlanIds),
        downloadBytes: wlanDownloadBytes,
        uploadBytes: wlanUploadBytes,
        counters: selectedWlanStats.map(instance => ({
          id: instance._InstID || null,
          downloadBytes: nonNegativeNumber(instance.TotalBytesSent) || 0,
          uploadBytes: nonNegativeNumber(instance.TotalBytesReceived) || 0
        }))
      },
      lan: {
        ports: lanStats.map(instance => ({
          id: instance._InstID || null,
          downloadBytes: nonNegativeNumber(instance.OutBytes) || 0,
          uploadBytes: nonNegativeNumber(instance.InBytes) || 0
        })),
        downloadBytes: lanDownloadBytes,
        uploadBytes: lanUploadBytes
      }
    }
  };
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

  async function authenticate(cleanIp, password) {
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
    return cookieJar;
  }

  async function readMenuData(cleanIp, password, pageTag, dataPath) {
    const cookieJar = await authenticate(cleanIp, password);
    const page = await request(
      cleanIp,
      cookieJar,
      `/?_type=menuView&_tag=${pageTag}&Menu3Location=0`
    );
    if (/SessionTimeout/i.test(page.text)) {
      throw new Error(`ZTE session expired before ${pageTag} could be read.`);
    }
    const data = await request(cleanIp, cookieJar, dataPath);
    if (/SessionTimeout/i.test(data.text)) {
      throw new Error(`ZTE session expired while reading ${dataPath}.`);
    }
    return data.text;
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
      const wanXml = await readMenuData(
        cleanIp,
        password,
        'ethWanStatus',
        '/?_type=menuData&_tag=wan_internetstatus_lua.lua&TypeUplink=2&pageType=1'
      );
      const params = parseZteParameters(wanXml);
      const rxBytes = Number(params.RxBytes);
      const txBytes = Number(params.TxBytes);
      if (!Number.isFinite(rxBytes) || !Number.isFinite(txBytes)) {
        throw new Error(`ZTE WAN counters were not available at ${cleanIp}.`);
      }

      let counterScope = 'access';
      let counterDetails;
      let downloadBytes = rxBytes;
      let uploadBytes = txBytes;
      try {
        const lanXml = await readMenuData(
          cleanIp,
          password,
          'localNetStatus',
          '/?_type=menuData&_tag=status_lan_info_lua.lua'
        );
        const wlanXml = await readMenuData(
          cleanIp,
          password,
          'localNetStatus',
          '/?_type=menuData&_tag=wlan_wlanstatus_lua.lua'
        );
        const access = aggregateZteAccessCounters(wlanXml, lanXml);
        downloadBytes = access.downloadBytes;
        uploadBytes = access.uploadBytes;
        counterDetails = {
          ...access.counterDetails,
          wanFallback: false,
          wan: { downloadBytes: rxBytes, uploadBytes: txBytes }
        };
      } catch (error) {
        counterScope = 'wan';
        counterDetails = {
          scope: 'wan-fallback',
          wanFallback: true,
          accessError: error.message,
          wan: { downloadBytes: rxBytes, uploadBytes: txBytes }
        };
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
          rxBytes: downloadBytes,
          txBytes: uploadBytes,
          downloadBytes,
          uploadBytes,
          totalBytes: downloadBytes + uploadBytes,
          uptimeSeconds: Number.isFinite(Number(params.UpTime)) ? Number(params.UpTime) : null,
          connectionStatus: params.ConnStatus || 'Unknown',
          counterScope,
          counterDetails
        }],
        counterStatus: 'snapshot'
      };
    }
  };
}

module.exports = {
  ZTE_SOURCE,
  aggregateZteAccessCounters,
  cleanRouterIp,
  createZteF6600PCollector,
  looksLikeZteGateway,
  parseZteInstances,
  parseZteParameters
};
