'use strict';

const fs = require('fs');
const path = require('path');
const {
  createEmptyState,
  normalizeState,
  normalizeUsageRecord,
  upsertSource,
  upsertUsageRecords
} = require('../domain/schema');

function isZteRecord(record) {
  return /ZTE F6600P|FibreX.*ZTE/i.test(`${record.rawMessage || ''} ${record.sourceLabel || ''}`);
}

function migrateLegacyState(raw) {
  if (raw && raw.schemaVersion) return normalizeState(raw);

  const state = createEmptyState();
  state.settings = {
    ...state.settings,
    ...(raw?.settings || {})
  };
  delete state.settings.zteCounterState;

  const legacyRecords = Array.isArray(raw?.records) ? raw.records : [];
  const records = legacyRecords.map(record => {
    const zte = isZteRecord(record);
    const source = zte
      ? {
          id: 'zte-f6600p',
          label: 'MTN FibreX • ZTE F6600P',
          kind: 'router-counter',
          model: 'ZTE F6600P',
          routerIp: raw?.settings?.zteCounterState?.routerIp || null,
          capabilities: { historical: false, cumulativeCounters: true }
        }
      : {
          id: 'legacy-import',
          label: 'Legacy imported record',
          kind: 'legacy',
          capabilities: { historical: true }
        };

    upsertSource(state, source);
    return normalizeUsageRecord({
      ...record,
      sourceId: source.id,
      sourceType: source.kind,
      sourceLabel: source.label,
      confidence: zte ? 'observed' : 'unknown',
      provenance: 'legacy-migration'
    }, source);
  });
  upsertUsageRecords(state, records);

  const legacyCounterState = raw?.settings?.zteCounterState;
  if (legacyCounterState) {
    const source = {
      id: 'zte-f6600p',
      label: 'MTN FibreX • ZTE F6600P',
      kind: 'router-counter',
      model: 'ZTE F6600P',
      routerIp: legacyCounterState.routerIp || null,
      capabilities: { historical: false, cumulativeCounters: true, resetDetection: true }
    };
    upsertSource(state, source);
    state.accounting['zte-f6600p'] = {
      sourceId: 'zte-f6600p',
      routerIp: legacyCounterState.routerIp || null,
      epochId: 'legacy-migration',
      dailyTotals: legacyCounterState.date
        ? {
            [legacyCounterState.date]: {
              downloadBytes: 0,
              uploadBytes: 0,
              unattributedBytes: Number(legacyCounterState.dayBytes) || 0,
              totalBytes: Number(legacyCounterState.dayBytes) || 0
            }
          }
        : {},
      lastObservation: {
        id: 'legacy-migration',
        sourceId: 'zte-f6600p',
        sourceType: 'router-counter',
        sourceLabel: source.label,
        routerIp: legacyCounterState.routerIp || null,
        observedAt: legacyCounterState.lastSeenAt || null,
        epochId: 'legacy-migration',
        downloadBytes: Number(legacyCounterState.lastRxBytes) || 0,
        uploadBytes: Number(legacyCounterState.lastTxBytes) || 0,
        totalBytes: Number(legacyCounterState.lastTotalBytes) || 0,
        uptimeSeconds: null,
        connectionStatus: 'Unknown',
        counterScope: 'wan'
      },
      lastStatus: 'legacy-migration',
      lastSeenAt: legacyCounterState.lastSeenAt || null
    };
  }

  state.legacy = {
    migratedAt: new Date().toISOString(),
    sourceFormat: 'pre-normalized-data-history'
  };
  return state;
}

class JsonStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.ensureFile();
  }

  ensureFile() {
    const directory = path.dirname(this.filePath);
    fs.mkdirSync(directory, { recursive: true });
    if (!fs.existsSync(this.filePath)) this.write(createEmptyState());
  }

  read() {
    this.ensureFile();
    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
    } catch (e) {
      if (e.code === 'ENOENT') {
        this.ensureFile();
        raw = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      } else {
        throw e;
      }
    }
    const state = migrateLegacyState(raw);
    if (!raw.schemaVersion || raw.schemaVersion !== state.schemaVersion) this.write(state);
    return state;
  }

  write(state) {
    const directory = path.dirname(this.filePath);
    const temporaryPath = path.join(directory, `.${path.basename(this.filePath)}.${process.pid}.tmp`);
    fs.writeFileSync(temporaryPath, JSON.stringify(state, null, 2));
    fs.renameSync(temporaryPath, this.filePath);
    return state;
  }

  update(mutator) {
    const state = this.read();
    const updated = mutator(state) || state;
    return this.write(updated);
  }
}

module.exports = {
  JsonStore,
  migrateLegacyState
};
