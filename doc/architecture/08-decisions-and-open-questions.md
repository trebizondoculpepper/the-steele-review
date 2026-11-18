# Decisions and open questions

## Agreed direction

| Decision                                          | Rationale                                          |
| ------------------------------------------------- | -------------------------------------------------- |
| Project name: The Steele Review                   | User-provided name                                 |
| Primary language: TypeScript                      | User preference, including readable error traces   |
| Vite+ tooling                                     | Original project setup request                     |
| Mac development; Docker execution on Raspberry Pi | User's intended operating environment              |
| Existing remote NATS and Elasticsearch            | Infrastructure already available on another server |
| Event-driven processing with separated components | Independent stages and recoverable execution       |
| Accumulate historical source content              | Recurrence, narrative evolution, and comparisons   |
| Automatic Substack publication                    | Minimise routine human interaction                 |
| Skip cases that fail verification                 | Manual review is deferred                          |

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

| Question                                                                              | Why it matters                                            |
| ------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| Pi model, OS, architecture, memory, disk, and deployment access                       | Images, resource budgets, and deployment procedure        |
| NATS address, version, credentials, JetStream availability, and permissions           | Durable delivery and stream/consumer configuration        |
| Elasticsearch address, version, credentials, existing mappings, and permitted indices | Client compatibility and safe index design                |
| Source publications and historical coverage target                                    | Discovery, retrieval, and backfill scope                  |
| Destination publication and authentication method                                     | Publishing proof of concept                               |
| Available archive and workflow-state infrastructure                                   | Durable originals, concurrency control, and event handoff |
| Model and transcription providers and budget                                          | Runtime footprint, cost, and throughput                   |
| Verification acceptance rules and attempt limits                                      | Reliable automatic publication and predictable skips      |
| Polling and publishing frequency, including subscriber email behaviour                | Operational and editorial policy                          |
| Behaviour when an already critiqued source post changes                               | Update, new article, or archive-only policy               |
| Correction policy for published articles                                              | Recovery from evidence changes or discovered errors       |

## Suggested implementation order

1. Finish the TypeScript/Vite+ backend baseline and establish Docker compatibility.
2. Validate NATS and Elasticsearch connections using isolated test resources.
3. Prove Substack ingestion and authenticated draft/publish reconciliation.
4. Select durable archive and workflow-state implementations.
5. Implement archive, extraction, indexing, and replayable event processing.
6. Add claims, history, evidence research, drafting, and automated verification.
7. Enable unattended publishing after duplicate-delivery and failure-recovery checks pass.

No infrastructure credentials or Pi details have been supplied in this discussion. No library choice, integration test, or deployment is implied to be complete by these documents.
