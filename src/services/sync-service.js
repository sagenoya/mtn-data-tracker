'use strict';

const {
  normalizeUsageRecord,
  upsertSource,
  upsertUsageRecords
} = require('../domain/schema');
const { ingestCounterSnapshot } = require('../domain/counter-accounting');

class SyncService {
  constructor({ store, registry, defaultRouterIp = '192.168.0.1', defaultRouterPassword = '' }) {
    this.store = store;
    this.registry = registry;
    this.defaultRouterIp = defaultRouterIp;
    this.defaultRouterPassword = defaultRouterPassword;
  }

  getState() {
    return this.store.read();
  }

  async sync({ collectorId = 'auto', routerIp, password, inputText } = {}) {
    if (collectorId === 'mtn-sms-text' || inputText) {
      return this.importSms(inputText);
    }

    const targetIp = routerIp || this.defaultRouterIp;
    const collector = collectorId !== 'auto'
      ? this.registry.get(collectorId)
      : await this.registry.resolveRouter({ collectorId, routerIp: targetIp });
    if (!collector) throw new Error(`Unknown collector: ${collectorId}`);
    const result = await collector.collect({
      routerIp: targetIp,
      password: password || this.defaultRouterPassword
    });
    return this.ingest(result);
  }

  importSms(inputText) {
    const collector = this.registry.resolveText();
    return collector.collect({ inputText }).then(result => this.ingest(result));
  }

  ingest(result) {
    let counterResult = null;
    let state = this.store.update(currentState => {
      const source = upsertSource(currentState, {
        ...result.source,
        lastCollectedAt: new Date().toISOString()
      });

      if (result.records?.length) {
        const normalizedRecords = result.records.map(record => normalizeUsageRecord(record, source));
        upsertUsageRecords(currentState, normalizedRecords, source);
      }

      (result.snapshots || []).forEach(snapshot => {
        counterResult = ingestCounterSnapshot(currentState, snapshot, source);
      });

      if (source.kind !== 'provider-sms') currentState.settings.detectedModel = source.label;
      currentState.lastSync = {
        success: true,
        sourceId: source.id,
        sourceType: source.kind,
        sourceLabel: source.label,
        routerIp: source.routerIp || null,
        observedAt: new Date().toISOString(),
        status: counterResult?.status || result.counterStatus || 'historical',
        recordsIngested: result.records?.length || counterResult?.records?.length || 0,
        observationId: counterResult?.observation?.id || null,
        error: null
      };
      return currentState;
    });

    const status = counterResult?.status || result.counterStatus || 'historical';
    return {
      success: true,
      schemaVersion: state.schemaVersion,
      source: result.source,
      detectedModel: result.source.label,
      counterStatus: status,
      counters: counterResult?.observation || null,
      records: state.records,
      data: state,
      sync: state.lastSync,
      events: counterResult?.event ? [counterResult.event] : []
    };
  }
}

module.exports = {
  SyncService
};
