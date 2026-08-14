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

function snapshot(observedAt, rxBytes, txBytes, uptimeSeconds = 100, counterScope = undefined, counterDetails = null) {
  return {
    sourceId: source.id,
    routerIp: '192.168.1.1',
    observedAt,
    rxBytes,
    txBytes,
    uptimeSeconds,
    connectionStatus: 'Connected',
    ...(counterScope ? { counterScope } : {}),
    ...(counterDetails ? { counterDetails } : {})
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

test('counter scope changes create a new baseline instead of mixing incompatible counters', () => {
  const state = createEmptyState();
  ingestCounterSnapshot(
    state,
    snapshot('2026-08-14T12:00:00.000Z', 1000, 2000),
    source
  );

  const accessBaseline = ingestCounterSnapshot(
    state,
    snapshot('2026-08-14T12:05:00.000Z', 1000000, 2000000, 120, 'access', {
      scope: 'access'
    }),
    source
  );
  assert.equal(accessBaseline.status, 'counter-scope-changed');
  assert.equal(accessBaseline.event.details.previousCounterScope, 'wan');
  assert.equal(accessBaseline.event.details.currentCounterScope, 'access');
  assert.equal(state.records.length, 0);
  assert.equal(state.accounting[source.id].lastObservation.counterScope, 'access');
  assert.deepEqual(state.accounting[source.id].lastObservation.counterDetails, {
    scope: 'access'
  });

  const update = ingestCounterSnapshot(
    state,
    snapshot('2026-08-14T12:10:00.000Z', 1000100, 2000050, 180, 'access', {
      scope: 'access'
    }),
    source
  );
  assert.equal(update.status, 'updated');
  assert.equal(state.records.at(-1).usageBytes, 150);
});

test('WAN fallback preserves the access cursor and lets the next access sync capture the gap', () => {
  const state = createEmptyState();
  const accessSource = {
    ...source,
    capabilities: { cumulativeCounters: true, counterScope: 'access' }
  };

  ingestCounterSnapshot(
    state,
    snapshot('2026-08-14T13:00:00.000Z', 1000, 2000, 100, 'access'),
    accessSource
  );

  const fallback = ingestCounterSnapshot(
    state,
    snapshot('2026-08-14T13:05:00.000Z', 500, 600, 400, 'wan', {
      scope: 'wan-fallback',
      wanFallback: true,
      accessError: 'temporary session error'
    }),
    accessSource
  );
  assert.equal(fallback.status, 'access-counters-unavailable');
  assert.equal(fallback.records.length, 0);
  assert.equal(state.accounting[source.id].lastObservation.counterScope, 'access');
  assert.equal(state.events.at(-1).type, 'counter-fallback');

  const accessUpdate = ingestCounterSnapshot(
    state,
    snapshot('2026-08-14T13:10:00.000Z', 1100, 2050, 500, 'access'),
    accessSource
  );
  assert.equal(accessUpdate.status, 'updated');
  assert.equal(state.records.at(-1).usageBytes, 150);
});
