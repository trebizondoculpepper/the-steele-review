# Implementation preparation brief

This is the planning handoff for the agreed proof of concept. GitHub tickets carry the current acceptance criteria, estimates, dependencies and claims. This document is a map, not a replacement task tracker.

## Existing discovery work

- #2 content schema and #6 CloudEvent factory are closed; preserve their merged contracts rather than redefining them.
- #7 RSS discovery and #8 historical discovery have active PRs. Do not duplicate or reset those implementers’ work.
- #4 NATS publishing, #9 single discovery run, #10 periodic scheduling, #11 backfill command and #12 container smoke test retain their existing estimates and now have explicit input/output contracts.
- #5 is the discovery parent; #3 groups the recent and historical controller implementations.

## Collection preparation

- #14 integrates Git artifacts and SQLite state after #21 and #22. It no longer needs to build both primitives from scratch.
- #15 acquires text/supplied transcripts through the controller. It can proceed without selecting a transcription provider.
- #16 owns temporary-media transcription lifecycle. Controlled-provider tests can proceed; real integration requires a chosen service.
- #17 composes the collector, preserving duplicate prevention and safe acknowledgment boundaries.

## Next-stage ticket map

| Ticket                                                                    | Deliverable                                                        | Initial complexity | Code prerequisites       |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------ | ------------------ | ------------------------ |
| [#21](https://github.com/trebizondoculpepper/the-steele-review/issues/21) | Implement immutable Git text artifact writer and reader            | M                  | None; see provider notes |
| [#22](https://github.com/trebizondoculpepper/the-steele-review/issues/22) | Implement SQLite operation claims and pending event records        | L                  | None; see provider notes |
| [#23](https://github.com/trebizondoculpepper/the-steele-review/issues/23) | Define full-text document schema and Elasticsearch mapping         | S                  | None; see provider notes |
| [#24](https://github.com/trebizondoculpepper/the-steele-review/issues/24) | Add idempotent document indexing to Elasticsearch controller       | M                  | #23                      |
| [#25](https://github.com/trebizondoculpepper/the-steele-review/issues/25) | Implement text-ready event indexing worker                         | L                  | #17, #21, #24            |
| [#26](https://github.com/trebizondoculpepper/the-steele-review/issues/26) | Add bounded archive-to-index replay command                        | M                  | #21, #24                 |
| [#27](https://github.com/trebizondoculpepper/the-steele-review/issues/27) | Implement deterministic passage splitting with provenance          | S                  | None; see provider notes |
| [#28](https://github.com/trebizondoculpepper/the-steele-review/issues/28) | Define embedding controller with injectable provider               | M                  | None; see provider notes |
| [#29](https://github.com/trebizondoculpepper/the-steele-review/issues/29) | Validate Elasticsearch vector capability and define vector storage | M                  | #28, #23                 |
| [#30](https://github.com/trebizondoculpepper/the-steele-review/issues/30) | Implement passage embedding worker                                 | L                  | #21, #27, #28, #29       |
| [#31](https://github.com/trebizondoculpepper/the-steele-review/issues/31) | Implement keyword and semantic passage retrieval                   | M                  | #29, #24                 |
| [#32](https://github.com/trebizondoculpepper/the-steele-review/issues/32) | Define source-grounded claim extraction contract                   | S                  | None; see provider notes |
| [#33](https://github.com/trebizondoculpepper/the-steele-review/issues/33) | Implement structured claim extraction controller                   | M                  | #32                      |
| [#34](https://github.com/trebizondoculpepper/the-steele-review/issues/34) | Implement claim extraction worker                                  | M                  | #21, #33, #17            |
| [#35](https://github.com/trebizondoculpepper/the-steele-review/issues/35) | Retrieve earlier coverage for an extracted claim                   | M                  | #31, #32                 |
| [#36](https://github.com/trebizondoculpepper/the-steele-review/issues/36) | Implement structured historical comparison analyser                | M                  | #35, #33, #21            |
| [#37](https://github.com/trebizondoculpepper/the-steele-review/issues/37) | Define reusable independent research entry schema                  | S                  | None; see provider notes |
| [#38](https://github.com/trebizondoculpepper/the-steele-review/issues/38) | Store and retrieve versioned independent research entries          | M                  | #37, #21, #24            |
| [#39](https://github.com/trebizondoculpepper/the-steele-review/issues/39) | Assess existing research applicability and evidence gaps           | M                  | #38, #32                 |
| [#40](https://github.com/trebizondoculpepper/the-steele-review/issues/40) | Implement bounded gap research with corpus updates                 | M                  | #39, #38                 |
| [#41](https://github.com/trebizondoculpepper/the-steele-review/issues/41) | Select evidence and save a versioned drafting brief                | M                  | #34, #39, #21            |
| [#42](https://github.com/trebizondoculpepper/the-steele-review/issues/42) | Implement template-based drafting controller and worker            | M                  | #41                      |
| [#43](https://github.com/trebizondoculpepper/the-steele-review/issues/43) | Implement draft verification against supplied evidence             | M                  | #42, #41                 |
| [#44](https://github.com/trebizondoculpepper/the-steele-review/issues/44) | Implement bounded drafting and verification revision loop          | L                  | #43, #42, #21            |
| [#45](https://github.com/trebizondoculpepper/the-steele-review/issues/45) | Prove authenticated Substack draft and publication adapter         | M                  | None; see provider notes |
| [#46](https://github.com/trebizondoculpepper/the-steele-review/issues/46) | Implement verified-artifact publisher worker                       | L                  | #45, #44, #22, #21       |

Sizes follow the PDB structural scale: S is one bounded behaviour; M is a contained capability across a few modules; L has interacting lifecycle/race/retry paths. They include tests and documentation, exclude dependency waiting, are not dates, and are not additive. New repository calibration is incomplete. Existing agents’ estimates on discovery tickets were preserved.

## Ready work and parallelism

After the existing schema/event contracts, acquisition can proceed alongside the archive/state primitives. Independent pure schema/splitting work can proceed in parallel. Use native GitHub dependencies for actual pickup eligibility, not just this narrative. New readiness labels are applied only to open, unclaimed work with no unfinished code prerequisite; no agent has been dispatched by this planning pass.

## Inputs still needed for live integration

- Embedding provider, model and dimensions, before accepting the vector mapping and live embedding path.
- Transcription provider and runtime configuration; supplied-transcript collection remains useful without it.
- Writing/verifying model provider and bounded request/cost policy.
- Research/search provider and source freshness/applicability policy for live gap research.
- Destination Substack publication, authentication, subscriber email behaviour and explicitly authorised test publication.

These are deployment/integration dependencies. Do not invent working integrations from fake-adapter tests. Keep credentials and real connection details in private configuration.

## Explicit proof-of-concept exclusions

No backup/restore or disaster-recovery implementation, no extra workflow platform, no new vector database without evidence of need, no retained media, no manual approval UI, and no automatic publication of backfill. Normal retries, safe side-effect handling and exact-draft verification remain required. Deferred low-priority backup assessment: #47.

## Review and validation

Every implementation needs focused behavioural evidence, architecture/security review and a linked PR. Planning changes do not authorise merging future implementation PRs or publishing real articles. Immutable provenance must survive all stages. The application repository must not contain private home configuration apart from the explicitly authorised ignored local environment file.
