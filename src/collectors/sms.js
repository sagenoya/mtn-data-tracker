'use strict';

const {
  BYTES_PER_GIB,
  normalizeUsageRecord
} = require('../domain/schema');

const SMS_SOURCE = {
  id: 'mtn-sms-text',
  label: 'MTN usage SMS',
  kind: 'provider-sms',
  capabilities: {
    historical: true,
    dailyRecords: true,
    cumulativeCounters: false
  }
};

function parseMtnUsageSms(text, source = SMS_SOURCE) {
  const records = [];
  const regex = /Y'?ello,?\s*(?:your\s*)?(corrected\s*)?data\s*usage\s*for\s*(\d{2}-\d{2}-\d{4})\s*is\s*([\d.]+)\s*(GB|MB|KB)/gi;
  let match;

  while ((match = regex.exec(String(text || ''))) !== null) {
    const isCorrected = Boolean(match[1]);
    const dateParts = match[2].split('-');
    const date = `${dateParts[2]}-${dateParts[1]}-${dateParts[0]}`;
    let value = Number(match[3]);
    let unit = match[4].toUpperCase();
    if (unit === 'GB' && value > 500) {
      unit = 'MB';
    }
    const multiplier = unit === 'GB'
      ? BYTES_PER_GIB
      : unit === 'MB'
        ? 1024 * 1024
        : 1024;

    records.push(normalizeUsageRecord({
      date,
      usageBytes: Math.round(value * multiplier),
      downloadBytes: null,
      uploadBytes: null,
      isCorrected,
      sourceId: source.id,
      sourceType: source.kind,
      sourceLabel: source.label,
      confidence: 'provider-reported',
      granularity: 'day',
      observedAt: new Date().toISOString(),
      provenance: 'mtn-sms',
      rawMessage: match[0]
    }, source));
  }

  return records;
}

function createSmsTextCollector() {
  return {
    id: SMS_SOURCE.id,
    label: SMS_SOURCE.label,
    kind: SMS_SOURCE.kind,
    capabilities: SMS_SOURCE.capabilities,
    async collect({ inputText }) {
      if (!inputText) throw new Error('SMS text is required for this collector.');
      const records = parseMtnUsageSms(inputText);
      if (records.length === 0) throw new Error('No MTN usage messages were found in the supplied text.');
      return {
        source: SMS_SOURCE,
        records,
        snapshots: [],
        counterStatus: 'historical'
      };
    }
  };
}

module.exports = {
  SMS_SOURCE,
  createSmsTextCollector,
  parseMtnUsageSms
};
