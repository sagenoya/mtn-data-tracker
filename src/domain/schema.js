'use strict';

const SCHEMA_VERSION = 1;
const BYTES_PER_GIB = 1024 * 1024 * 1024;

const SOURCE_RANKS = {
  'provider-sms': 4,
  'router-sms': 3,
  'router-counter': 2,
  imported: 2,
  manual: 2,
  estimated: 1,
  legacy: 1,
  unknown: 0
};

function asFiniteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function asNonNegativeInteger(value) {
  const number = asFiniteNumber(value);
  return number === null ? null : Math.max(0, Math.round(number));
}

function roundUsageGB(bytes) {
  return Number((Math.max(0, Number(bytes) || 0) / BYTES_PER_GIB).toFixed(2));
}

function localDateString(date = new Date()) {
  const value = date instanceof Date ? date : new Date(date);
  const local = new Date(value.getTime() - value.getTimezoneOffset() * 60000);
  return local.toISOString().substring(0, 10);
}

function sourceRank(record) {
  const rank = SOURCE_RANKS[record.sourceType] ?? SOURCE_RANKS.unknown;
  return rank + (record.isCorrected ? 10 : 0);
}

function normalizeSource(source = {}) {
  return {
    id: source.id || 'unknown',
    label: source.label || source.model || source.id || 'Unknown source',
    kind: source.kind || source.sourceType || 'unknown',
    model: source.model || null,
    routerIp: source.routerIp || null,
    capabilities: source.capabilities || {},
    lastCollectedAt: source.lastCollectedAt || null
  };
}

function normalizeUsageRecord(record = {}, source = {}) {
  const normalizedSource = normalizeSource(source);
  const providedUsageBytes = asNonNegativeInteger(record.usageBytes);
  const providedUsageGB = asFiniteNumber(record.usageGB);
  const downloadBytes = record.downloadBytes === null
    ? null
    : asNonNegativeInteger(record.downloadBytes);
  const uploadBytes = record.uploadBytes === null
    ? null
    : asNonNegativeInteger(record.uploadBytes);

  let usageBytes = providedUsageBytes;
  if (usageBytes === null && providedUsageGB !== null) {
    usageBytes = Math.max(0, Math.round(providedUsageGB * BYTES_PER_GIB));
  }
  if (usageBytes === null && downloadBytes !== null && uploadBytes !== null) {
    usageBytes = downloadBytes + uploadBytes;
  }
  if (usageBytes === null) usageBytes = 0;

  const observedAt = record.observedAt || null;
  return {
    date: String(record.date || localDateString(observedAt || new Date())).substring(0, 10),
    usageBytes,
    downloadBytes,
    uploadBytes,
    usageGB: roundUsageGB(usageBytes),
    isCorrected: Boolean(record.isCorrected),
    sourceId: record.sourceId || normalizedSource.id,
    sourceType: record.sourceType || normalizedSource.kind,
    sourceLabel: record.sourceLabel || normalizedSource.label,
    confidence: record.confidence || 'observed',
    granularity: record.granularity || 'day',
    observedAt,
    provenance: record.provenance || record.sourceId || normalizedSource.id,
    rawMessage: record.rawMessage || ''
  };
}

function createEmptyState() {
  return {
    schemaVersion: SCHEMA_VERSION,
    settings: {
      monthlyLimitGB: 1000,
      cycleStartDay: 1,
      isUnlimited: true,
      detectedModel: null
    },
    sources: [],
    records: [],
    recordVariants: [],
    observations: [],
    events: [],
    accounting: {},
    lastSync: null
  };
}

function upsertSource(state, source) {
  const normalized = normalizeSource(source);
  const index = state.sources.findIndex(item => item.id === normalized.id);
  if (index === -1) state.sources.push(normalized);
  else state.sources[index] = { ...state.sources[index], ...normalized };
  return normalized;
}

function chooseRecord(existing, incoming) {
  if (!existing) return incoming;
  const existingRank = sourceRank(existing);
  const incomingRank = sourceRank(incoming);
  if (incomingRank !== existingRank) return incomingRank > existingRank ? incoming : existing;

  const existingObserved = existing.observedAt ? Date.parse(existing.observedAt) : 0;
  const incomingObserved = incoming.observedAt ? Date.parse(incoming.observedAt) : 0;
  return incomingObserved >= existingObserved ? incoming : existing;
}

function rebuildVisibleRecords(state) {
  const visible = new Map();
  state.recordVariants.forEach(record => {
    visible.set(record.date, chooseRecord(visible.get(record.date), record));
  });
  state.records = Array.from(visible.values()).sort((a, b) => a.date.localeCompare(b.date));
}

function upsertUsageRecords(state, records, source = {}) {
  const variants = new Map();
  const existingRecords = Array.isArray(state.recordVariants) && state.recordVariants.length > 0
    ? state.recordVariants
    : (state.records || []);
  existingRecords.forEach(record => {
    const normalized = normalizeUsageRecord(record, source);
    variants.set(`${normalized.sourceId}:${normalized.date}`, normalized);
  });

  (records || []).forEach(record => {
    const normalized = normalizeUsageRecord(record, source);
    variants.set(`${normalized.sourceId}:${normalized.date}`, normalized);
  });

  state.recordVariants = Array.from(variants.values()).sort((a, b) => {
    return `${a.date}:${a.sourceId}`.localeCompare(`${b.date}:${b.sourceId}`);
  });
  rebuildVisibleRecords(state);
  return state.records;
}

function appendObservation(state, observation) {
  state.observations.push(observation);
  // JSON storage is intentionally bounded while the storage interface remains replaceable.
  if (state.observations.length > 10000) state.observations.splice(0, state.observations.length - 10000);
}

function appendEvent(state, event) {
  state.events.push({
    id: event.id || `${event.type}:${event.sourceId}:${event.occurredAt}`,
    occurredAt: event.occurredAt || new Date().toISOString(),
    type: event.type || 'info',
    sourceId: event.sourceId || 'unknown',
    details: event.details || {}
  });
}

function normalizeState(raw = {}) {
  const state = createEmptyState();
  state.schemaVersion = raw.schemaVersion || SCHEMA_VERSION;
  state.settings = { ...state.settings, ...(raw.settings || {}) };
  state.sources = Array.isArray(raw.sources) ? raw.sources.map(normalizeSource) : [];
  state.observations = Array.isArray(raw.observations) ? raw.observations : [];
  state.events = Array.isArray(raw.events) ? raw.events : [];
  state.accounting = raw.accounting && typeof raw.accounting === 'object' ? raw.accounting : {};
  Object.values(state.accounting).forEach(account => {
    Object.values(account.dailyTotals || {}).forEach(total => {
      if (total.unattributedBytes === undefined) {
        const knownBytes = Number(total.downloadBytes) || 0;
        const uploadBytes = Number(total.uploadBytes) || 0;
        total.unattributedBytes = Math.max(0, (Number(total.totalBytes) || 0) - knownBytes - uploadBytes);
      }
    });
  });
  state.lastSync = raw.lastSync || null;
  state.legacy = raw.legacy || null;
  const rawRecords = Array.isArray(raw.recordVariants) && raw.recordVariants.length > 0
    ? raw.recordVariants
    : (raw.records || []);
  upsertUsageRecords(state, rawRecords);
  return state;
}

module.exports = {
  BYTES_PER_GIB,
  SCHEMA_VERSION,
  appendEvent,
  appendObservation,
  asFiniteNumber,
  createEmptyState,
  localDateString,
  normalizeSource,
  normalizeState,
  normalizeUsageRecord,
  roundUsageGB,
  upsertSource,
  upsertUsageRecords
};
