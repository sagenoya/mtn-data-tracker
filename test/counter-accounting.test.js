'use strict';

process.env.TZ = 'UTC';

const test = require('node:test');
const assert = require('node:assert/strict');

const { ingestCounterSnapshot } = require('../src/domain/counter-accounting');
const { createEmptyState } = require('../src/domain/schema');

const source = {
  id: 'test-router',
  label: 'Test router',
  kind: 'router-counter',
  capabilities: { cumulativeCounters: true }
};

function snapshot(observedAt, rxBytes, txBytes, uptimeSeconds = 100) {
  return {
    sourceId: source.id,
    routerIp: '192.168.1.1',
    observedAt,
    rxBytes,
    txBytes,
    uptimeSeconds,
    connectionStatus: 'Connected'
  };
}

test('counter collector creates a baseline, accumulates deltas, and preserves usage across a reset', () => {
  const state = createEmptyState();

  const baseline = ingestCounterSnapshot(
    state,
    snapshot('2026-08-14T10:00:00.000Z', 1000, 2000),
    source
  );
  assert.equal(baseline.status, 'baseline');
  assert.equal(state.records.length, 0);

  const update = ingestCounterSnapshot(
    state,
    snapshot('2026-08-14T10:05:00.000Z', 1100, 2200, 400),
    source
  );
  assert.equal(update.status, 'updated');
  assert.equal(state.records.length, 1);
  assert.equal(state.records[0].usageBytes, 300);

  const reset = ingestCounterSnapshot(
    state,
    snapshot('2026-08-14T11:00:00.000Z', 10, 20, 20),
    source
  );
  assert.equal(reset.status, 'counter-reset');
  assert.equal(state.records[0].usageBytes, 300);
  assert.equal(state.events.at(-1).type, 'counter-reset');

  const afterReset = ingestCounterSnapshot(
    state,
    snapshot('2026-08-14T11:05:00.000Z', 60, 70, 320),
    source
  );
  assert.equal(afterReset.status, 'updated');
  assert.equal(state.records[0].usageBytes, 400);
});

test('counter deltas crossing midnight are split between local daily buckets', () => {
  const state = createEmptyState();
  ingestCounterSnapshot(state, snapshot('2026-08-14T23:59:00.000Z', 0, 0), source);

  ingestCounterSnapshot(
    state,
    snapshot('2026-08-15T00:01:00.000Z', 600, 400, 220),
    source
  );

  assert.equal(state.records.length, 2);
  assert.equal(state.records[0].usageBytes + state.records[1].usageBytes, 1000);
});
