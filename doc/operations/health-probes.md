# Role health probes (#323)

Each long-running process gets its own probe, not a single shared HTTP check. A probe gives two answers:

- **Liveness (`--live`):** local and cheap. It contacts no dependency and always exits 0 if the probe process can start.
- **Readiness (default):** runs each dependency check through its existing controller, each within its own time limit (5 s by default, or `STEELE_PROBE_TIMEOUT_MS`, from 100 to 60000). It prints one JSON line and exits 0 when every check is healthy and 1 otherwise.

Each check reports `healthy`, `unavailable` or `not-configured`. A dependency outage shows up as not ready; it isn't a liveness failure, so it can't cause a restart loop.

Probes are read-only. They never provision, consume, acknowledge, publish, repair, start a run or call a model. Their output contains only fixed check names and states: no URLs, hosts, paths, credentials or raw errors.

## Inventory

| Role | Command | Checks |
| --- | --- | --- |
| Collector (#324) | `node dist/cli/probe-collector.js` | `broker`: NATS answers. `consumer`: the collector's own durable consumer exists on its stream (read-only info, never recreated). `archive`: the archive is a readable Git repository (never initialised). `state`: the operation store opens read-only (never created or migrated). |
| Discovery poller (#327) | `node dist/cli/probe-discovery.js` | `status`: the runner's sanitised status file is present and valid. `poll`: the last completed poll is no older than `STEELE_PROBE_STALE_AFTER_MS` (default three `STEELE_POLL_INTERVAL_MS` intervals); an unchanged feed is a completed poll, so it counts as healthy. `failures`: consecutive failed polls are below `STEELE_PROBE_MAX_FAILURES` (default 3). `details` carries `runs`, `consecutiveFailures` and `lastPollAt`. The feed and broker are never contacted. Needs `STEELE_DISCOVERY_STATUS_PATH`. |
| Git-triggered captured-post indexer (#326) | `node dist/cli/probe-captured-index.js` | `archive`: the capture archive is a readable Git repository. `trigger`: the durable catch-up checkpoint every pass starts from is readable and names an indexed revision. `search`: the logical full-text index (`STEELE_FULLTEXT_INDEX`) answers a one-document read. `state`: the store holding the pass lease opens read-only. Reconciliation progress goes in `details` (`checkpoint`, `unindexedChanges`, `passInProgress`) and never affects readiness. No pass is run and no lease is taken. |
| Legacy text-ready indexer (#325), while deployed | `node dist/cli/probe-text-ready-indexer.js` | `broker`: NATS answers. `consumer`: the indexer's own durable text-ready consumer exists (`STEELE_INDEX_STREAM` / `STEELE_INDEX_CONSUMER`; read-only info, never recreated). `search`: the logical full-text index (`STEELE_FULLTEXT_INDEX`) answers a one-document read. |

The collector probe reads the collector's own configuration: `NATS_URL`, `NATS_TOKEN`, `STEELE_COLLECT_STREAM`, `STEELE_COLLECT_CONSUMER`, `STEELE_ARCHIVE_PATH`, `STEELE_ARCHIVE_REPOSITORY` and `STEELE_STATE_PATH`. A missing variable makes that check `not-configured`.

Example healthy output:

```json
{"schemaVersion":1,"role":"collector","live":true,"ready":true,"checks":{"broker":"healthy","consumer":"healthy","archive":"healthy","state":"healthy"}}
```

Example Compose health check for the collector service:

```yaml
healthcheck:
  test: ["CMD", "node", "dist/cli/probe-collector.js"]
  interval: 60s
  timeout: 30s
  start_period: 30s
```

Docker marks the container unhealthy and does not restart it. Wiring this into a deployment and recording the observed result belongs to the #323 rollout.
