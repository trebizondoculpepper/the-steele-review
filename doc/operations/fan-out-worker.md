# Fan-out worker

After `announce-post` records one post-analysed completion, the fan-out worker records one durable event per detected theme occurrence and one per accepted claim occurrence (#179). These are the handoffs the librarian and researcher consume; the aggregate completion event remains the analysis handoff.

```sh
NATS_URL=<broker> STEELE_CONTENT_PATH=<content repository path> \
STEELE_CONTENT_REPOSITORY=<logical name> STEELE_STATE_PATH=<absolute path of the state file> \
STEELE_ANALYSIS_STREAM=<stream> STEELE_ANALYSIS_CONSUMER=<durable consumer> \
  npm run -s fan-out-worker
```

Paths and broker settings are private configuration; keep them in the private deployment notes.

Before starting the worker on a deployment that already has an analysis stream, run `npm run -s provision`. Registry streams accept an additive subject upgrade (the new occurrence subjects are added and retained messages are kept); any other difference is still refused.

- Subjects `steele.v1.theme.occurred` and `steele.v1.claim.occurred`, both retained by the analysis stream (registered before this worker ships). Payloads carry only exact artifact references, the occurrence identity, the stable claim identity and the linked theme proposal IDs — no source prose.
- The worker re-reads and validates the referenced theme and claim results before fan-out. Unreadable, legacy, mismatched, unlinked or contract-invalid results are refused and recorded as a permanent failure; nothing is published. A transient repository failure instead releases the claim with a recorded `fan-out:artifact-unavailable` code and defers the parent; repeated failures leave an inspectable exhausted operation rather than a silently dropped message.
- One operation covers one exact parent analysis, so a duplicate parent delivery records nothing new. Completion and all occurrence events are written in one state transaction; a publish failure leaves the events pending with the same IDs.
- Pending events are drained at start-up and on a periodic interval (default 30s, `STEELE_FAN_OUT_DISPATCH_INTERVAL_MS`), not only while handling another parent: a crash or outage after acknowledging the parent cannot strand downstream work.
- A repeated theme or claim in a later post is a new occurrence of the same identity: deduplication uses the stable theme/claim identity plus input versions, never the event count.
- Read-only with respect to sources: no model calls, retrieval, research or drafting.
