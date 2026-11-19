# Announcing an analysed post

After `detect-themes` and `extract-claims` have saved results for a post, `announce-post` records one post-analysed completion event and, when asked, publishes it.

```sh
STEELE_PUBLICATION_ID=<publication> \
STEELE_CONTENT_PATH=<content repository path> STEELE_CONTENT_REPOSITORY=<logical name> \
STEELE_STATE_PATH=<absolute path of the analysis state file> \
  npm run -s announce-post -- --post-id <slug> [--claim-result <repository path>] [--publish] [--json]
```

Paths and broker settings are private configuration; keep them in the private deployment notes.

- The post's schema-v2 claim-extraction result is used (pass `--claim-result` if there is more than one), together with the exact theme-proposal result it links to. Both must describe the same post and source text version. Legacy, unreadable, mismatched or unlinked results are refused and no event is recorded.
- The event is first recorded in the configured state-controller outbox (`STEELE_STATE_PATH`; the POC has one configured state store and broker). Recording precedes any broker connection, so an outage leaves a durable pending event instead of losing the handoff. Without `--publish` it stays pending and the output says `delivery: pending`. With `--publish` (and `NATS_URL`, `NATS_TOKEN[_FILE]`) the recorded event is then sent and marked `sent`; a failed connect or send stays pending for the next run and the command exits 1.
- Exit 0 means recorded (and sent when `--publish` succeeded); 1 means refused, busy, exhausted, or recorded but not published; 2 is usage or configuration.
- Subject `steele.v1.post.analysed`, stream `STEELE_ANALYSIS` (created by `provision`). Nothing consumes it yet.
- The event ID is derived from the two result references, so repeated runs, restarts and duplicate deliveries yield one logical completion. A changed theme or claim result is a new analysis version and gets a new event.
- The payload carries exact artifact references, model/prompt/schema versions and counts (theme proposals, accepted claims, candidates, rejected). It announces validated stage completion, not perfect semantic quality, and does not imply proposals were mapped to canonical themes.
