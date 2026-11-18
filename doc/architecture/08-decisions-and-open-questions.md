# Decisions and open questions

## Agreed direction

| Decision                                          | Rationale                                                                                                  |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Project name: The Steele Review                   | User-provided name                                                                                         |
| Application and test code: TypeScript             | Other languages require a justified, agreed exception; scripts automation may use suitable local languages |
| Vite+ tooling                                     | Original project setup request                                                                             |
| Mac development; Docker execution on Raspberry Pi | User's intended operating environment                                                                      |
| Existing remote NATS and Elasticsearch            | Infrastructure already available on another server                                                         |
| Event-driven processing with separated components | Independent stages and recoverable execution                                                               |
| Accumulate historical source content              | Recurrence, narrative evolution, and comparisons                                                           |
| Automatic Substack publication                    | Minimise routine human interaction                                                                         |
| Skip cases that fail verification                 | Manual review is deferred                                                                                  |

## Message format decision

CloudEvents structured JSON is the standard envelope. Zod defines payload validation and inferred TypeScript types; exported JSON Schema provides the shared data contract and dictionary. See [events and reliability](05-events-and-reliability.md).

## Proposed implementation choices

- RSS-first discovery with a separate historical-import path.
- Official NATS Node transport and JetStream clients, subject to server capability checks.
- Official Elasticsearch Node client matched to the server version.
- A source archive separate from searchable derived records.
- Versioned events, structured model output, and runtime schema validation.
- Durable workflow state, conditional operation claims, and recoverable event handoff.
- Separate writing and verification, with bounded research/revision attempts.
- Docker Compose with configurable worker roles and concurrency.
- Evaluate Restate for durable workflow coordination through a small pilot before committing; retain JetStream with explicit state as the fallback. See [suggested software choices](09-software-choices.md).

## Information still required

| Question                                                                              | Why it matters                                                                                     |
| ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Pi model, OS, architecture, memory, disk, and deployment access                       | Images, resource budgets, and deployment procedure                                                 |
| NATS address, version, credentials, JetStream availability, and permissions           | Durable delivery and stream/consumer configuration                                                 |
| Elasticsearch address, version, credentials, existing mappings, and permitted indices | Client compatibility and safe index design                                                         |
| Source publications and historical coverage target                                    | Discovery, retrieval, and backfill scope                                                           |
| Destination publication and authentication method                                     | Publishing proof of concept                                                                        |
| Private archive/state volume configuration                                            | Git artifacts and SQLite backend are settled; private mount paths remain operational configuration |
| Model and transcription providers and budget                                          | Runtime footprint, cost, and throughput                                                            |
| Verification acceptance rules and attempt limits                                      | Reliable automatic publication and predictable skips                                               |
| Polling and publishing frequency, including subscriber email behaviour                | Operational and editorial policy                                                                   |
| Behaviour when an already critiqued source post changes                               | Update, new article, or archive-only policy                                                        |
| Correction policy for published articles                                              | Recovery from evidence changes or discovered errors                                                |

## Suggested implementation order

1. Finish the TypeScript/Vite+ backend baseline and establish Docker compatibility.
2. Validate NATS and Elasticsearch connections using isolated test resources.
3. Prove Substack ingestion and authenticated draft/publish reconciliation.
4. Select durable archive and workflow-state implementations.
5. Implement archive, extraction, indexing, and replayable event processing.
6. Add claims, history, evidence research, drafting, and automated verification.
7. Enable unattended publishing after duplicate-delivery and failure-recovery checks pass.

No infrastructure credentials or Pi details have been supplied in this discussion. No library choice, integration test, or deployment is implied to be complete by these documents.

## Initial collection storage decision

SQLite stores collector state and durable handoff records; a persistent file volume stores retained text and provenance. Elasticsearch is a derived searchable copy. This settles the initial collector backend; actual storage paths, backup configuration and deployment remain private operational choices. See [storage and retrieval](03-storage-and-retrieval.md).

## Preparation boundary

Discovery contracts are ready for implementers, with historical access investigated inside its ticket. Collection and later processing stages are described in [processing stages](10-processing-stages.md). Models/providers, publication destination and live authenticated tests remain unresolved deployment inputs. They do not block schema work, controlled-adapter tests, full-text indexing or supplied-transcript collection. Existing completed tickets and active implementer claims must not be reset by planning updates.

## Subsequent proof-of-concept decisions

- Retain SQLite, private to a narrow in-process state controller. Do not replace it with Elasticsearch workflow state or add a state microservice initially.
- Prefer existing source transcripts; evaluate local whisper.cpp with one transcription at a time. Measure quality and throughput before increasing the workload. OpenRouter is the intended configurable model gateway/fallback; no key or successful live integration is implied.
- Rely on the provider key's spending limit initially. Exhausted credit leaves affected work pending with a visible reason and bounded retry/backoff; no separate proactive spending-cap subsystem is required.
- Choose Kagi for search/extraction, with API setup deferred until live research testing. Interfaces and fixtures can proceed without credentials.
- Begin with three historical posts processed one at a time through content capture and full-text indexing only. The earlier first-milestone verified-draft target is superseded by [the four milestones](13-milestones.md); research and writing come later. Keep publication disabled and increase the batch only after inspecting capture quality and failures.
- The researcher first assesses corpus sufficiency, reuses established evidence and may run a bounded Kagi freshness check when a new post warrants it. No scheduled refresh jobs or automatic dossier expiry.
- Initial drafting format: summary of the post, related conspiratorial themes, factual errors and underlying reasoning errors, supported by citations. Detailed editorial style is deferred.
- Use established bounded-retry, timeout, jitter, idempotency and failure-quarantine patterns as described in [failure handling](12-failure-handling.md).

Five queries and ten pages per research run were suggested as configurable starting limits, but no numerical research budget was explicitly agreed. Do not treat those values as a mandatory approved policy.

## Initial secret delivery

Use protected host files mounted read-only into only the containers that need each credential. Keep them outside Git and image build contexts and out of logs/prompts/artifacts. Do not introduce a secrets service for the proof of concept. Research alternatives, setup requirements and maintained TypeScript/CLI integrations in #65; defer migration until a later explicit decision. File-backed Compose secrets are delivery, not encrypted central storage. Actual paths and private configuration remain in the separate infrastructure documentation project.
