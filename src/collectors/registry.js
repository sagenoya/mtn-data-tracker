'use strict';

const { createSmsTextCollector } = require('./sms');
const { createZteF6600PCollector } = require('./zte-f6600p');
const { createZteUbusCollector } = require('./zte-ubus');
const { createZltSmsCollector } = require('./zlt-sms');

function publicMetadata(collector) {
  return {
    id: collector.id,
    label: collector.label,
    kind: collector.kind,
    model: collector.model || null,
    capabilities: collector.capabilities || {}
  };
}

function createCollectorRegistry(options = {}) {
  const builtInCollectors = [
    createZteF6600PCollector(options),
    createZteUbusCollector(options),
    createZltSmsCollector(options),
    createSmsTextCollector()
  ];
  const collectors = [...builtInCollectors, ...(options.collectors || [])];
  const byId = new Map(collectors.map(collector => [collector.id, collector]));

  return {
    list() {
      return collectors.map(publicMetadata);
    },

    get(id) {
      return byId.get(id) || null;
    },

    async resolveRouter({ collectorId = 'auto', routerIp }) {
      if (collectorId && collectorId !== 'auto') {
        const collector = byId.get(collectorId);
        if (!collector || collector.kind === 'provider-sms') {
          throw new Error(`Unknown router collector: ${collectorId}`);
        }
        return collector;
      }

      const routerCollectors = collectors.filter(collector => collector.kind !== 'provider-sms');
      const probeResults = await Promise.all(routerCollectors.map(async collector => ({
        collector,
        result: await collector.probe({ routerIp })
      })));
      const match = probeResults.find(item => item.result?.matched);
      if (match) return match.collector;

      const reasons = probeResults
        .map(item => item.result?.error)
        .filter(Boolean);
      throw new Error(reasons[0] || `No supported router collector detected at ${routerIp}.`);
    },

    resolveText() {
      return byId.get('mtn-sms-text');
    }
  };
}

module.exports = {
  createCollectorRegistry
};
