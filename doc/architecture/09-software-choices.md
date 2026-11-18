# Suggested software choices

These are recommendations for implementation and evaluation, not a record of installed or proven integrations. TypeScript, Vite+, Docker deployment, and the existing NATS and Elasticsearch services are agreed direction. Workflow orchestration and the remaining libraries are provisional.

## Candidate stack

| Responsibility                | Suggested choice                                                              | Selection notes                                                                                                                       |
| ----------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Application runtime           | Node.js with TypeScript                                                       | Preserve readable production stack traces using source maps; choose a supported runtime compatible with dependencies and the Pi.      |
| Development tooling           | Vite+ and the TypeScript compiler                                             | Checks, formatting, tests, and build tooling; workers execute as a backend under Node.                                                |
| Messaging                     | `@nats-io/transport-node`                                                     | Official Node transport for the existing NATS service.                                                                                |
| Durable event delivery        | `@nats-io/jetstream`                                                          | Confirm JetStream availability, server compatibility, permissions, and retention.                                                     |
| Search client                 | `@elastic/elasticsearch`                                                      | Official client with TypeScript definitions; match the existing server's supported version.                                           |
| Durable workflow coordination | Restate, evaluated through a small pilot                                      | Candidate for progress tracking, retries, timers, and restart recovery. Validate footprint and architecture support before selection. |
| Workflow fallback             | JetStream consumers with explicit durable state and recoverable event handoff | Reuses existing messaging infrastructure but requires application-owned coordination and recovery logic.                              |
| Substack discovery            | Publication RSS feeds                                                         | Initial new-post detection; full extraction and historical backfill remain separate.                                                  |
| Substack API adapter          | Evaluate `substack-ts` and `unofficial-substack-sdk`                          | Unofficial candidates; prove authentication, draft creation, publishing, and status reconciliation before selection.                  |
| Runtime validation            | A TypeScript schema library, to be selected                                   | Validate configuration, events, and model responses at process boundaries.                                                            |
| Deployment                    | Docker Compose                                                                | Proposed way to run a small number of application processes on the Pi with persistent volumes.                                        |

Archive storage, model and transcription providers, structured logging library, error tracking, and the durable state backend remain open choices. Avoid adding a second language unless a concrete dependency requires it.

## Restate evaluation

Restate offers a TypeScript SDK and a self-hosted runtime packaged as a single binary. It is worth testing because the pipeline includes multiple external calls and needs recovery after partial completion. This is a hypothesis about suitability, not a measured claim about Raspberry Pi resource use.

Pilot one representative path using fixture content and a controlled publisher adapter:

1. Accept a source event and persist an extraction result.
2. Run a simulated model step and store its output.
3. Stop and restart the application and workflow runtime at different boundaries.
4. Deliver the same input again and verify completed work is reused.
5. Exercise transient failure, bounded retries, and an editorial skip.
6. Simulate an uncertain publish response and reconcile the existing destination record.

Measure idle and active memory, CPU, disk growth, and operational complexity on the actual deployment machine. Check container architecture support, persistence, backup/restore, and the current self-hosting license before adoption.

If adopted, define a clear ownership boundary: NATS transports incoming and external events; Restate owns the progress and retries within a workflow. The exact NATS-to-workflow handoff must be designed and tested. Do not maintain two competing authoritative stage-state machines. Review the proposed stage-event topology and outbox requirements in [events and reliability](05-events-and-reliability.md) against that ownership model.

If the pilot is unsuitable, use JetStream directly and select a durable state store with conditional updates and an outbox or equivalent recovery mechanism. JetStream delivery alone does not supply the entire business workflow.

Neither approach removes the need for stable operation IDs, external-side-effect reconciliation, or duplicate prevention at the Substack publishing boundary.

## References

- [Official NATS JavaScript client modules](https://github.com/nats-io/nats.js/blob/main/migration.md)
- [NATS JetStream delivery and acknowledgments](https://docs.nats.io/concepts/jetstream)
- [Elasticsearch TypeScript support](https://www.elastic.co/docs/reference/elasticsearch/clients/javascript/typescript)
- [Restate durable execution overview](https://restate.dev/what-is-durable-execution)
- [Restate TypeScript SDK](https://www.npmjs.com/package/@restatedev/restate-sdk)
- [Substack RSS documentation](https://support.substack.com/hc/en-us/articles/360038239391-Is-there-an-RSS-feed-for-my-publication)
- [substack-ts](https://github.com/ma2za/substack-ts)
- [unofficial-substack-sdk](https://github.com/cucoleadan/unofficial-substack-sdk)

## Agreed message schema stack

Use CloudEvents 1.0 structured JSON (`cloudevents`) for envelopes and Zod for runtime payload validation and inferred TypeScript types. Export JSON Schema from the Zod definitions for the shared contract and field dictionary. These choices are agreed rather than provisional; implementation remains future work. AsyncAPI can later describe subjects and message contracts. See [events and reliability](05-events-and-reliability.md) for field meanings, versioning, validation, and deduplication.

## Collector proof-of-concept choice

The initial collector uses SQLite for operation state/pending handoffs and a private Git repository on a persistent volume for text artifacts. Restate is deferred as a possible later evaluation, not a launch dependency. Backups and disaster recovery are outside the proof of concept; ordinary retries, immutable provenance and duplicate-publication prevention remain required.
