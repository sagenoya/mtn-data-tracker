# WiFiWatch architecture

WiFiWatch is organized around a normalized ingestion contract. The dashboard does not know whether data came from an SMS message, a ZLT router API, or a ZTE cumulative counter.

```text
collector adapter → normalized collection result → sync service → storage → dashboard API
```

## Normalized collection result

Every collector returns:

```js
{
  source: {
    id,
    label,
    kind,
    model,
    routerIp,
    capabilities
  },
  records: [],       // historical or already-normalized daily records
  snapshots: [],     // live cumulative counters, when supported
  counterStatus
}
```

Daily records use bytes as the durable value and retain `usageGB` as a display convenience. They also include source, confidence, granularity, observation time, and provenance.

## Collector types

- `mtn-sms-text` parses provider-reported daily SMS history.
- `zlt-sms` authenticates to the ZLT API and returns the router's SMS history.
- `zte-f6600p` authenticates to the F6600P and returns a WAN snapshot containing download bytes, upload bytes, uptime, and connection status.

The registry is the extension point. A new router or provider source only needs to implement the collector contract and register itself; the accounting and dashboard layers remain unchanged.

## Counter accounting

The counter accounting service stores raw observations and derives daily records:

- First observation creates a baseline.
- Non-decreasing counters contribute download/upload deltas.
- A lower counter starts a new counter epoch and records a reset event.
- A lower uptime records a reconnect/restart signal without discarding counters that continued normally.
- Deltas crossing local midnight are split between daily buckets.

This means router restarts and WAN-session resets do not erase previously known usage. Usage during an outage or before the first observation cannot be reconstructed locally.

## Storage boundary

`JsonStore` is the current local implementation of the storage interface. It migrates the original `data_history.json` shape into normalized state with sources, records, raw observations, accounting state, and events. A SQLite or other durable store can replace it without changing collectors or the dashboard API.

The browser keeps only a cache for offline/static mode. When the local service is available, `/api/history` is authoritative and the dashboard refreshes from it.

## Running the local collector

```bash
ROUTER_IP=192.168.1.1 \
ROUTER_PASSWORD='your-router-password' \
AUTO_SYNC_INTERVAL_MINUTES=5 \
npm start
```

With a password configured, the local service collects at startup and at the configured interval, whether or not the dashboard is open. The password should eventually move to macOS Keychain before packaging this as a menu-bar or `launchd` agent.
