# Events and reliability

## Delivery model

Use existing NATS infrastructure. Proposed Node packages are `@nats-io/transport-node` and `@nats-io/jetstream`: [official client module documentation](https://github.com/nats-io/nats.js/blob/main/migration.md).

Confirm that JetStream is enabled and determine server version, storage limits, retention, authentication, and permissions before relying on durable delivery. The design assumes messages can be redelivered and workers can restart at any point. It does not assume exactly-once execution.

## Proposed event contract

Each event includes `eventId`, `eventType`, `schemaVersion`, `occurredAt`, `correlationId`, `causationId`, `sourceId`, `sourceVersion`, `ingestionReason`, and an artifact reference where applicable. Validate events at runtime. Keep bodies small; originals and audio belong in the archive.

Proposed subject prefix: `steele.v1`.

| Subject suffix       | Durable fact                                   |
| -------------------- | ---------------------------------------------- |
| `source.detected`    | New or changed source discovered               |
| `source.archived`    | Original saved                                 |
| `content.extracted`  | Text or transcript saved                       |
| `content.indexed`    | Searchable source ready                        |
| `analysis.completed` | Claims, themes, and history saved              |
| `research.completed` | Evidence bundle saved                          |
| `article.drafted`    | Draft saved                                    |
| `article.verified`   | Publishable draft passed checks                |
| `article.skipped`    | Editorial processing ended without publication |
| `article.published`  | Destination publication confirmed              |

These names are proposals, not deployed contracts. Configure durable consumers and bounded concurrency by stage.

## Worker pattern

1. Validate the event and derive a stable operation key from source version, stage, and processor version.
2. Acquire or conditionally claim the operation in durable state so concurrent consumers cannot both perform it.
3. Reuse an already completed result; otherwise do the work and save its artifact.
4. Record completion and the downstream event that must be emitted.
5. Emit the downstream event and acknowledge the input after durable handoff.

Writing state and publishing to NATS are separate operations. An outbox or equivalent recoverable handoff is required: a dispatcher retries pending events, and downstream consumers deduplicate them. Without this, a crash between saving a result and emitting its event can silently stall the pipeline. The durable state/outbox implementation remains an open decision.

Stable Elasticsearch document IDs prevent duplicate records but do not by themselves prevent repeated model charges or concurrent external side effects.

## Failure handling

Retry transient network and service failures with backoff and bounded attempts. Record permanent validation failures and exhausted operations separately from editorial skips. Retain enough information to inspect and replay failed work. A periodic reconciliation pass finds abandoned operations and pending handoffs.

## Publication boundary

Persist publication intent and the destination draft ID before attempting publication. If a call has an uncertain result, query the existing draft/post to reconcile its status. Never create a fresh article merely because a publish response was lost. If reconciliation is inconclusive, retain `publication_uncertain` and stop automatic publication for that item until status can be established.

Technical uncertainty is not an editorial skip. Do not claim exactly-once publishing unless the destination actually supports an appropriate idempotency mechanism.
