'use strict';

const {
  appendEvent,
  appendObservation,
  asFiniteNumber,
  localDateString,
  normalizeUsageRecord,
  upsertUsageRecords
} = require('./schema');

function addDailyBytes(dailyTotals, date, downloadBytes, uploadBytes) {
  if (!dailyTotals[date]) {
    dailyTotals[date] = {
      downloadBytes: 0,
      uploadBytes: 0,
      unattributedBytes: 0,
      totalBytes: 0
    };
  }

  dailyTotals[date].downloadBytes += downloadBytes;
  dailyTotals[date].uploadBytes += uploadBytes;
  dailyTotals[date].totalBytes += downloadBytes + uploadBytes;
}

function addDeltaAcrossDates(dailyTotals, previousAt, currentAt, downloadBytes, uploadBytes) {
  const from = previousAt ? new Date(previousAt) : null;
  const to = new Date(currentAt);
  if (!from || !Number.isFinite(from.getTime()) || from >= to) {
    addDailyBytes(dailyTotals, localDateString(to), downloadBytes, uploadBytes);
    return [localDateString(to)];
  }

  const totalDuration = to.getTime() - from.getTime();
  const touchedDates = new Set();
  let cursor = from;

  while (cursor < to) {
    const nextMidnight = new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate() + 1);
    const segmentEnd = nextMidnight < to ? nextMidnight : to;
    const ratio = (segmentEnd.getTime() - cursor.getTime()) / totalDuration;
    const segmentDownload = downloadBytes * ratio;
    const segmentUpload = uploadBytes * ratio;
    const date = localDateString(cursor);
    addDailyBytes(dailyTotals, date, segmentDownload, segmentUpload);
    touchedDates.add(date);
    cursor = segmentEnd;
  }

  return Array.from(touchedDates);
}

function createEpochId(sourceId, observedAt) {
  return `${sourceId}:${observedAt.replace(/[^0-9]/g, '').substring(0, 14)}`;
}

function dailyRecordFor(source, date, totals, observedAt) {
  const downloadBytes = Math.max(0, Math.round(totals.downloadBytes || 0));
  const uploadBytes = Math.max(0, Math.round(totals.uploadBytes || 0));
  const unattributedBytes = Math.max(0, Math.round(totals.unattributedBytes || 0));
  const usageBytes = downloadBytes + uploadBytes + unattributedBytes;
  const usageGB = (usageBytes / (1024 * 1024 * 1024)).toFixed(2);
  return normalizeUsageRecord({
    date,
    usageBytes,
    downloadBytes,
    uploadBytes,
    observedAt,
    confidence: 'observed',
    granularity: 'day',
    provenance: source.id,
    rawMessage: `${source.label} counters: ${usageGB} GB observed (download ${
      (downloadBytes / (1024 * 1024 * 1024)).toFixed(2)
    } GB, upload ${(uploadBytes / (1024 * 1024 * 1024)).toFixed(2)} GB)`
  }, source);
}

function ingestCounterSnapshot(state, snapshot, source) {
  const sourceId = source.id;
  const observedAt = snapshot.observedAt || new Date().toISOString();
  const currentRx = asFiniteNumber(snapshot.downloadBytes ?? snapshot.rxBytes);
  const currentTx = asFiniteNumber(snapshot.uploadBytes ?? snapshot.txBytes);
  if (currentRx === null || currentTx === null || currentRx < 0 || currentTx < 0) {
    throw new Error(`Collector ${sourceId} returned invalid cumulative counters.`);
  }

  const currentUptime = asFiniteNumber(snapshot.uptimeSeconds ?? snapshot.upTime);
  const currentCounterScope = snapshot.counterScope || 'wan';
  const routerIp = snapshot.routerIp || source.routerIp || null;
  const previous = state.accounting[sourceId] || null;
  const previousObservation = previous?.lastObservation || null;
  const dailyTotals = { ...(previous?.dailyTotals || {}) };
  const touchedDates = [];
  let status = 'baseline';
  let event = null;
  let epochId = previous?.epochId || createEpochId(sourceId, observedAt);

  const hasPrevious = Boolean(previousObservation);
  const sourceChanged = hasPrevious && previousObservation.routerIp !== routerIp;
  const counterReset = hasPrevious && (
    currentRx < Number(previousObservation.downloadBytes) ||
    currentTx < Number(previousObservation.uploadBytes)
  );
  const counterScopeChanged = hasPrevious &&
    (previousObservation.counterScope || 'wan') !== currentCounterScope;
  const uptimeReset = hasPrevious && currentUptime !== null && previousObservation.uptimeSeconds !== null &&
    currentUptime < Number(previousObservation.uptimeSeconds);

  // The ZTE collector can retain WAN counters as a diagnostic fallback when
  // its access pages are temporarily unavailable. Do not replace the access
  // cursor with that smaller/incompatible counter: the next access snapshot
  // can then account for the whole interval without losing the fallback gap.
  const accessCollectorUsingWanFallback = hasPrevious &&
    source.capabilities?.counterScope === 'access' &&
    currentCounterScope === 'wan' &&
    (previousObservation.counterScope || 'wan') === 'access';

  if (accessCollectorUsingWanFallback) {
    const observation = {
      id: `${sourceId}:${observedAt}`,
      sourceId,
      sourceType: source.kind,
      sourceLabel: source.label,
      routerIp,
      observedAt,
      epochId: previous.epochId,
      downloadBytes: Math.round(currentRx),
      uploadBytes: Math.round(currentTx),
      totalBytes: Math.round(currentRx + currentTx),
      uptimeSeconds: currentUptime,
      connectionStatus: snapshot.connectionStatus || 'Unknown',
      counterScope: currentCounterScope,
      counterDetails: snapshot.counterDetails || null
    };
    const event = {
      type: 'counter-fallback',
      sourceId,
      occurredAt: observedAt,
      details: {
        routerIp,
        previousCounterScope: previousObservation.counterScope || 'wan',
        fallbackCounterScope: currentCounterScope,
        accessError: snapshot.counterDetails?.accessError || null,
        accessCursorPreserved: true
      }
    };
    appendObservation(state, observation);
    state.accounting[sourceId] = {
      ...previous,
      lastStatus: 'access-counters-unavailable',
      lastSeenAt: observedAt,
      lastDiagnosticObservation: observation
    };
    appendEvent(state, event);
    return {
      status: 'access-counters-unavailable',
      records: [],
      observation,
      event,
      dailyTotals
    };
  }

  if (!hasPrevious || sourceChanged || counterReset || counterScopeChanged) {
    epochId = createEpochId(sourceId, observedAt);
    status = !hasPrevious
      ? 'baseline'
      : (sourceChanged
        ? 'source-changed'
        : (counterReset ? 'counter-reset' : 'counter-scope-changed'));
    event = {
      type: status,
      sourceId,
      occurredAt: observedAt,
      details: {
        routerIp,
        previousRouterIp: previousObservation?.routerIp || null,
        previousDownloadBytes: previousObservation?.downloadBytes ?? null,
        previousUploadBytes: previousObservation?.uploadBytes ?? null,
        currentDownloadBytes: currentRx,
        currentUploadBytes: currentTx,
        previousUptimeSeconds: previousObservation?.uptimeSeconds ?? null,
        currentUptimeSeconds: currentUptime,
        previousCounterScope: previousObservation?.counterScope || 'wan',
        currentCounterScope
      }
    };
  } else {
    const deltaDownload = currentRx - Number(previousObservation.downloadBytes);
    const deltaUpload = currentTx - Number(previousObservation.uploadBytes);
    const dates = addDeltaAcrossDates(
      dailyTotals,
      previousObservation.observedAt,
      observedAt,
      deltaDownload,
      deltaUpload
    );
    touchedDates.push(...dates);
    status = uptimeReset ? 'uptime-reset' : (deltaDownload + deltaUpload > 0 ? 'updated' : 'unchanged');

    if (uptimeReset) {
      event = {
        type: 'uptime-reset',
        sourceId,
        occurredAt: observedAt,
        details: {
          previousUptimeSeconds: previousObservation.uptimeSeconds,
          currentUptimeSeconds: currentUptime,
          countersContinued: true
        }
      };
    }
  }

  const observation = {
    id: `${sourceId}:${observedAt}`,
    sourceId,
    sourceType: source.kind,
    sourceLabel: source.label,
    routerIp,
    observedAt,
    epochId,
    downloadBytes: Math.round(currentRx),
    uploadBytes: Math.round(currentTx),
    totalBytes: Math.round(currentRx + currentTx),
    uptimeSeconds: currentUptime,
    connectionStatus: snapshot.connectionStatus || 'Unknown',
    counterScope: currentCounterScope,
    counterDetails: snapshot.counterDetails || null
  };

  state.accounting[sourceId] = {
    sourceId,
    routerIp,
    epochId,
    dailyTotals,
    lastObservation: observation,
    lastStatus: status,
    lastSeenAt: observedAt
  };
  appendObservation(state, observation);
  if (event) appendEvent(state, event);

  const records = touchedDates
    .filter(date => dailyTotals[date] && dailyTotals[date].totalBytes > 0)
    .map(date => dailyRecordFor(source, date, dailyTotals[date], observedAt));
  upsertUsageRecords(state, records, source);

  return {
    status,
    records,
    observation,
    event,
    dailyTotals
  };
}

module.exports = {
  ingestCounterSnapshot
};
