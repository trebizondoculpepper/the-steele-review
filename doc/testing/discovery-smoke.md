# Discovery container smoke test

The smoke test builds the application image and runs live discovery and backfill in containers against synthetic resources only: a fixture HTTPS source served by the test (with a self-signed certificate generated per run) and a disposable `nats:2 -js` server. No private service, credential or production configuration is involved.

## Running it

Requirements: Docker, `openssl` and the project's npm dependencies.

```sh
STEELE_SMOKE=1 npx vp test run test/smoke --testTimeout=600000 --hookTimeout=600000
```

Without `STEELE_SMOKE=1` the suite is skipped, so the normal `npm test` run does not need Docker.

## What it checks

- **Repeated live polling.** `dist/cli/discover.js` polls the fixture feed every second; the same three posts are announced at least twice as `live` CloudEvents with distinct event IDs.
- **Broker outage.** The NATS container is stopped; the discovery container keeps running and backs off.
- **Restart recovery.** NATS is started again; previously stored events are intact and polling resumes publishing.
- **Overlapping backfills.** `dist/cli/backfill.js` runs twice with overlapping bounds (3, then 5 posts); both exit 0, every event is `backfill`, and an overlapping post keeps the same content subject with a new event ID.
- **Honest failure.** A backfill configured for a stream that does not exist exits nonzero and reports `ok: false` at the `publish` stage.
- **Envelope and payload.** Every stored message is decoded with `parseDiscoveryEvent`, which validates the CloudEvents envelope and the Zod payload.
- **Sanitised logs.** Discovery container logs contain no source host or NATS URL.

Repeated event delivery is expected: deduplicating content work by publication and post ID is the job of downstream collection, not discovery.

## Expected result

```text
 Tests  2 passed (2)
```

A failing check fails the test run with a nonzero exit. The test removes only what it created: its two containers, its network, its image tag and its temporary certificate directory.
