# Events and reliability

## Delivery model

Use existing NATS infrastructure. Proposed Node packages are `@nats-io/transport-node` and `@nats-io/jetstream`: [official client module documentation](https://github.com/nats-io/nats.js/blob/main/migration.md).

Confirm that JetStream is enabled and determine server version, storage limits, retention, authentication, and permissions before relying on durable delivery. The design assumes messages can be redelivered and workers can restart at any point. It does not assume exactly-once execution.

## Event contract

Use CloudEvents 1.0 structured JSON as the event envelope, with Zod schemas for application payloads. Export JSON Schema from the same Zod definitions as the portable contract. This is the agreed message-format choice; libraries and message publishing are not implemented by this documentation change.

The `cloudevents` package provides the `CloudEvent` class for envelope construction and validation. Zod validates each event's `data` and derives its TypeScript type. Send the structured JSON as UTF-8 bytes through the NATS controller. The CloudEvents JavaScript SDK does not supply a NATS transport binding; our controller handles transport without inventing another envelope format.

| CloudEvents field | Meaning                                                                            |
| ----------------- | ---------------------------------------------------------------------------------- |
| `specversion`     | CloudEvents specification version, initially `1.0`; not the payload schema version |
| `id`              | Unique event identity within `source`; preserve it when retrying the same event    |
| `source`          | Stable logical producer URI; must not reveal a private deployment hostname         |
| `type`            | Versioned event type identifying the application payload contract                  |
| `time`            | When this event occurred, such as the time discovery was recorded                  |
| `subject`         | Stable logical content identifier when applicable                                  |
| `datacontenttype` | `application/json`                                                                 |
| `dataschema`      | Stable public schema identifier for this payload version                           |
| `data`            | Validated application payload                                                      |

Correlation and causation IDs may use documented CloudEvents extension attributes `correlationid` and `causationid`. Keep extensions consistently named and avoid parallel custom fields that duplicate standard envelope attributes.

Discovery payloads contain publication ID, stable post ID, canonical public URL, available publication/update dates, and `ingestionReason` (`live`, `backfill`, or `reprocess`). Discovery emits metadata only; fetching and extraction happen downstream. A source version or artifact reference is included only when known, not invented at discovery time.

The same post can be discovered through live polling and backfill. Envelope identity (`source`, `id`) deduplicates event redelivery; publication/post identity deduplicates content work across distinct discovery events. Neither a random event ID nor the discovery-run correlation ID is a content deduplication key.

### Validation and data dictionary

Define payload schemas once in TypeScript using Zod and derive types rather than maintaining separate interfaces. Validate before publishing and after decoding on receipt; validate the CloudEvents envelope as well as its data. Route by supported event type/schema version and reject or quarantine malformed or unsupported messages without passing them into business logic. Diagnostic output must not dump raw payloads or private configuration.

Export JSON Schema with `z.toJSONSchema()` using JSON-compatible schema constructs. Each schema documents required/optional fields, field descriptions, formats, identifiers, examples, and versioning rules. This forms the data dictionary; do not maintain an independent handwritten schema that can drift from runtime validation. Generated schemas and examples must contain only public or synthetic values.

Additive optional fields may be compatible if consumers explicitly tolerate them; breaking changes require a new payload version and a documented rollout. Keep CloudEvents `specversion` separate from that application version. AsyncAPI is optional later for documenting the mapping between NATS subjects and message schemas; it is not required to launch discovery.

Keep messages small: metadata and artifact references only. Do not send media bytes, credentials, or private infrastructure details. Audio/video remains temporary transcription input under the retention policy.

References: [CloudEvents JavaScript SDK](https://github.com/cloudevents/sdk-javascript), [Zod](https://zod.dev/), [Zod JSON Schema export](https://zod.dev/json-schema), [AsyncAPI payload schemas](https://www.asyncapi.com/docs/concepts/asyncapi-document/define-payload).

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

Writing state and publishing to NATS are separate operations. An outbox or equivalent recoverable handoff is required: a dispatcher retries pending events, and downstream consumers deduplicate them. Without this, a crash between saving a result and emitting its event can silently stall the pipeline. The initial collector uses SQLite for operation state and pending-event handoff records; Git holds immutable text artifacts. See the storage decision and processing-stage contracts.

Stable Elasticsearch document IDs prevent duplicate records but do not by themselves prevent repeated model charges or concurrent external side effects.

## Failure handling

Retry transient network and service failures with backoff and bounded attempts. Record permanent validation failures and exhausted operations separately from editorial skips. Retain enough information to inspect and replay failed work. A periodic reconciliation pass finds abandoned operations and pending handoffs.

## Publication boundary

Persist publication intent and the destination draft ID before attempting publication. If a call has an uncertain result, query the existing draft/post to reconcile its status. Never create a fresh article merely because a publish response was lost. If reconciliation is inconclusive, retain `publication_uncertain` and stop automatic publication for that item until status can be established.

Technical uncertainty is not an editorial skip. Do not claim exactly-once publishing unless the destination actually supports an appropriate idempotency mechanism.

## Shared stream and message registry

`src/events/registry.ts` is the single inventory of JetStream streams and application subjects. Subjects are `steele.v1.<area>.<event>`; streams are `STEELE_<RESPONSIBILITY>`, one per responsibility (never per post, theme or claim). Existing deployed names are kept. Each stream's name can be overridden with its configured environment variable; subjects are fixed contract identities.

`provision` creates streams from the registry, so there is no second handwritten list. The reference at [generated/streams-and-messages.md](generated/streams-and-messages.md) is generated with `npm run events:reference`; tests fail if it drifts, if a subject is captured by two streams, if a stream subject has no message definition, or if a name breaks the convention.

To add a message: export its subject and event type beside its schema, add a `MESSAGES` entry, assign it to an existing stream whose purpose fits or add a `STREAMS` entry, then regenerate the reference. Changing an existing deployed stream's subjects is a migration: document and scope it separately before changing live configuration.

## Versioned editorial attempts

New article inputs explicitly serialize the `assess-judge-v1` editorial policy, including the revision limit and shared deadline. Restate journals preparation, each assessment, each judgment, each writer revision and the approval handoff separately. Inputs without that policy retain the legacy combined-verification step sequence on replay; changing deployed code or available stage methods does not select a different journal contract.

Assessment and judgment model calls reuse the durable returned-output capture machinery with a distinct editorial purpose. Raw returned text is committed to the private corpus before classification. An interrupted or unfenced response remains inspectable but cannot become an empty successful assessment or an approval. Failed, incomplete and malformed role records, retained-call references and reuse facts remain linked in the saved editorial-loop history. Provider credit failures are operational stops, distinct from requests for editorial correction.

A judgment-backed approval names its actual judgment and assessment, not a fabricated legacy verifier report. Both outbox creation and destination delivery re-read the complete assessment, decided approval, deterministic gates and exact publication manifest. The manifest binds body and all generated fields; metadata-only edits need a new assessment/judgment. Legacy approval records remain readable, and uncertain delivery continues to reconcile the original saved intent and payload.

The owner-authorized draft-only exception uses a distinct V2 authorization envelope on the existing publication subject, while normal V1 events and retained workflow journals stay unchanged. A separate immutable operator request pins the exact retained revision and remaining findings; no model or source text can enable it. Typed state atomically records authorization plus its outbox event, with one owner request per selected version. Consumers verify the persisted owner authority, exact event scope and current draft-only destination identity before cached receipts, reconciliation or creation. Old and new envelope schemas remain explicit in the single subject registry. V2-capable dummy consumers and the selected operator must be deployed before this mode emits an event; continuous real publishing stays off.

An operator may deliberately rerun an unchanged article with `article-run --request-id <stable-id>`. The typed state controller records the request/input binding before submission and provides a new workflow identity without changing the true source version or deleting the old result. Repeating the same request attaches to that attempt; changing its inputs is a conflict, and another intentional attempt needs a different request ID. Status inspection follows the recorded attempt key. This is separate from the dashboard's credit-only recovery action.

`STEELE_EDITORIAL_MAX_REVISIONS`, `STEELE_EDITORIAL_EXHAUSTION_ACTION` and
`STEELE_EDITORIAL_DEADLINE_MS` are defined in the shared settings registry.
Historical `assess-judge-v1` inputs retain their submission-time policy and legacy
CLI overrides, so their journals and request hashes remain reproducible. New
`live-policy-v1` normal inputs carry no editorial configuration snapshot: future
decisions obtain a coherent validated observation from the configuration handler.
Record only the non-secret applied policy and its revision; never copy credentials
or the complete configuration. Live stop/target checks also govern future delivery
effects, including receipt and saved-intent paths. Research allowance and publishing
permissions remain separate controls. See [live configuration authority](07-runtime-and-operations.md#live-configuration-authority-owner-decision).

The initial assessment/judgment does not count as a revision. A limit of 1 allows
one substantive rewrite, and 0 allows none. At exhaustion, `stop` preserves the
unresolved result. The explicitly owner-authorized `create-unpublished-draft`
exception is capability-limited and never changes a REVISE verdict into APPROVE.
Unsupported actions fail validation. Current settings-file changes govern the next
new normal-flow decision without restarting; completed decisions replay unchanged.

### Live configured normal article drafts

An explicit serialized `live-policy-v1` normal ArticleRun contract may apply the
owner's configured unpublished-draft exhaustion policy. It adds named durable
policy observations; absent selectors retain old steps and input behavior. Current
configuration governs future decisions, while replay preserves completed applied
observations. Never infer the new sequence from deployed methods or an environment
flag alone.

This flow seals its own exact recorded-attempt/output/review/mechanical proof; it
must not forge a terminal retained-recovery parent. Authorization is distinct from
factual approval and commits with the existing state-controller outbox. The V2
capability-limited event, both independent dummy receipts and selected one-event
Substack consumer are the shared delivery path. Only an unpublished editable draft
without email is authorized, with current action and target checks before future
external effects. See [configured unpublished drafts](../editorial-draft-policy.md).
