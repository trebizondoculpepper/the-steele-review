# Recurring source polls: discovery and deduplication (#867)

Date: 2026-11-24. Code: main plus the test in `test/collection/poll-dedup.test.ts`.

## Synthetic check

The test drives the real chain on a temporary Git archive and state database:
1. live discovery events from `runDiscovery`;
2. the `CollectionWorker`;
3. its source-ready (captured-content) events;
4. `handleCapturedContent`, with a submitter that, like Restate, admits one workflow per key.

No network, broker, Restate or model calls are made.

| Step | Entries discovered | Fetches (cumulative) | Source-ready events (distinct) | Automatic runs |
|---|---|---|---|---|
| Initial poll, posts `one` and `two` | 2 | 2 | 2 | 2 |
| Unchanged repeat poll | 2 | 2 | 2 | 2 |
| Poll after `one` is edited at the source | 2 | 2 | 2 | 2 |
| Poll with new post `three` | 3 | 3 | 3 | 3 |
| Explicit resend of a source-ready event | — | 1 | 1 (same event ID) | 1 |
| Deliberate reingestion of `one` (`edit-1`), requested twice and delivered twice | — | 2 | 2 | 1 |

What the table shows:
- **Repeats are suppressed in collection.** Discovery republishes every feed entry on every poll. The collector recognises an already collected post and does no fetch, makes no capture commit (`collected.json` keeps one commit), emits no event, and starts no run.
- **New posts still flow.** A genuinely new post produces exactly one capture, one source-ready event and one automatic run.
- **A resend keeps identity.** It carries the same event ID, and the bridge attaches to the existing run, so it isn't multiplied.
- **Edits are not picked up by polling.** Rediscovery does not refetch a collected post. An edit is captured only by an explicit reingestion request: one refetch and one revision at the same path, with two commits. Repeating the same request ID does nothing. The revised capture is announced as `reprocess`, which starts **no** automatic run.
- **What this means for #865 and #870.** The current automatic-run key includes the text hash. So if an edit were ever announced as `live`, it would start a second run. Keying runs by post (#870) removes that risk.

## Live schedule

The effective poll schedule on the deployment was checked read-only. The observations are kept in the private infrastructure notes, not in this repository. The acceptance check is:
- one discoverer is running, so there is one effective schedule;
- its status file reports a recent completed poll and no consecutive failures;
- each poll's republished entries are suppressed by collection, as the synthetic check shows.

After #864 is rolled out, the check becomes: one active `DiscoveryPoll` chain per source.

No real publishing was triggered, and no article runs were started.
