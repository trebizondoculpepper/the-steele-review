# NATS messaging contract standard

Every application message crossing NATS follows one standard (#273, part of #268). The registry in `src/events/registry.ts` is the single place where a message is declared; the [generated reference](generated/streams-and-messages.md) is produced from it and a test fails if the two drift.

## Registering a message

Each `MESSAGES` entry records:

| Element | Where |
| --- | --- |
| Event name | `eventType`, a versioned CloudEvents type (`org.steele.<area>.<event>.v<N>`) |
| Subject | `subject`, `steele.v1.<area>.<event>` |
| Stream | `stream`, a `STEELE_<RESPONSIBILITY>` stream from `STREAMS` (or `null` while unprovisioned) |
| Runtime schema | the Zod schema exported beside the subject in `src/events/<name>-event.ts`, with a JSON Schema export |
| Producer | `producer` |
| Emission condition | `emittedWhen`: the state change that emits it |
| Consumer guarantees | `guarantees`: identity, deduplication, redelivery and invalid-payload handling |

A message retained by a provisioned stream must state `emittedWhen` and `guarantees`; the registry check fails otherwise.

## Schemas and types

The Zod schema is the source of truth. TypeScript types are derived from it (`z.infer`), and the JSON Schema for consumers in other languages comes from the same schema (`z.toJSONSchema`). Producers validate before publishing (the `create…Event` functions parse their data); consumers validate the whole envelope and payload on receipt (`parse…Event`), including the CloudEvents fields and that the subject matches the payload. Validation errors never echo payloads.

## Compatibility

Within a version, changes are additive and optional: new optional fields only, never removing, renaming or retyping a field. Anything else is a new version: a new `eventType` (`…v2`) and, if consumers cannot accept both side by side, a new subject, emitted alongside the old one until every consumer has moved. The captured-content event (#269) is an example: a new source-neutral subject added next to the Substack-specific text-ready event, which is unchanged. Adding a subject to an existing stream is additive; changing a deployed stream's subjects otherwise is a migration, planned separately.

## Identity and delivery

- **Stable identity.** Event IDs are derived from the immutable inputs (for example a job ID, an artifact hash or a draft and approval pair), so re-emitting the same fact produces the same ID and JetStream deduplicates it (`msgId`).
- **Outbox.** Producers record events in the state controller's outbox in the same step as the state change, then dispatch them; a restart between the two cannot lose or duplicate a handoff.
- **References, not content.** Messages carry exact artifact references (repository, commit, path, hash). Consumers re-read content through the artifact controller, which verifies the hash.
- **Acknowledgment.** Consumers use explicit acknowledgment and acknowledge only after their own durable state is recorded. Redelivery must be safe: consumers key their work by a stable operation key and reuse a completed result.
- **Retries.** A transient failure is negatively acknowledged with a delay; a busy resource is retried shortly. Consumers bound their retries and record an exhausted message durably before terminating it.
- **Invalid payloads.** A message that fails envelope or payload validation is terminated (never redelivered) and, where the consumer records state, recorded with a sanitised reason.
