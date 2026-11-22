# Streams and messages

Generated from `src/events/registry.ts` by `npm run events:reference`. Do not edit by hand.

## Streams

| Stream | Override | Captures | Purpose |
| --- | --- | --- | --- |
| `STEELE_DISCOVERY` | `STEELE_DISCOVERY_STREAM` | `steele.v1.source.detected` | Newly discovered or redelivered source posts awaiting capture. |
| `STEELE_CONTENT` | `STEELE_CONTENT_STREAM` | `steele.v1.content.extracted`, `steele.v1.content.captured` | Captured source text ready for indexing and analysis. |
| `STEELE_ANALYSIS` | `STEELE_ANALYSIS_STREAM` | `steele.v1.post.analysed`, `steele.v1.theme.occurred`, `steele.v1.claim.occurred` | Analysis-stage handoffs: one post-analysed completion per post and analysis version, plus its per-theme and per-claim occurrence events. |
| `STEELE_RESEARCH` | `STEELE_RESEARCH_STREAM` | `steele.v1.research.completed`, `steele.v1.research.reindex.requested` | Research job completions (complete, complete with gaps, failed) and research-index reconciliation requests. |
| `STEELE_PUBLICATION` | `STEELE_PUBLICATION_STREAM` | `steele.v1.article.approved` | Approved articles, consumed independently by each configured destination (#262). |

## Messages

| Subject | Event type | Stream | Producer | Description |
| --- | --- | --- | --- | --- |
| `steele.v1.source.detected` | `org.steele.source.detected.v1` | `STEELE_DISCOVERY` | discover, backfill, retry-collection | A source post to capture. |
| `steele.v1.content.extracted` | `org.steele.content.extracted.v1` | `STEELE_CONTENT` | collect-worker | Captured text archived and ready. |
| `steele.v1.post.analysed` | `org.steele.post.analysed.v1` | `STEELE_ANALYSIS` | announce-post | Theme proposals and claims saved for one post. |
| `steele.v1.theme.occurred` | `org.steele.theme.occurred.v1` | `STEELE_ANALYSIS` | fan-out-worker | One detected theme occurrence in a saved analysis. |
| `steele.v1.claim.occurred` | `org.steele.claim.occurred.v1` | `STEELE_ANALYSIS` | fan-out-worker | One extracted claim occurrence in a saved analysis. |
| `steele.v1.research.completed` | `org.steele.research.completed.v1` | `STEELE_RESEARCH` | research jobs (#215) | A research job reached a terminal outcome. |
| `steele.v1.research.reindex.requested` | `org.steele.research.reindex.requested.v1` | `STEELE_RESEARCH` | research-reindex CLI, external schedulers (#232) | Reconcile one configured research-index route from its checkpoint. |
| `steele.v1.content.captured` | `org.steele.content.captured.v1` | `STEELE_CONTENT` | collect-worker (Substack); any ingestion source | Source-neutral captured item revision for the writing engine (#269). |
| `steele.v1.article.approved` | `org.steele.article.approved.v1`, `org.steele.article.draft-authorized.v2` | `STEELE_PUBLICATION` | recordApproval; explicit owner draft authorization | V1 exact-version editorial approval, or V2 explicitly owner-authorized unpublished draft rehearsal; never an invented factual approval. |
| `steele.v1.claims.extracted` | `org.steele.claims.extracted.v1` | not provisioned | claim-worker | Claims extracted by the automatic worker. |
| `steele.v1.content.embedded` | `org.steele.content.embedded.v1` | not provisioned | embedding-consumer | Passages embedded. |
| `steele.v1.research.requested` | `org.steele.research.requested.v1` | not provisioned | research-coordinator | Research requested for an analysed post. |
| `steele.v1.brief.ready` | `org.steele.brief.ready.v1` | not provisioned | brief | Drafting brief saved. |
| `steele.v1.draft.ready` | `org.steele.draft.ready.v1` | not provisioned | drafting-worker | Draft saved. |
| `steele.v1.draft.verified` | `org.steele.draft.verified.v1` | not provisioned | verification-worker | Draft verification report saved. |
| `steele.v1.revision.decided` | `org.steele.revision.decided.v1` | not provisioned | revision-worker | Revision decision recorded. |
| `steele.v1.article.published` | `org.steele.article.published.v1` | not provisioned | publisher-worker | Article published. |

## Message contracts

The standard these follow is in doc/architecture/20-messaging-contract.md.

| Subject | Emitted when | Consumer guarantees |
| --- | --- | --- |
| `steele.v1.source.detected` | A feed poll, backfill or retry finds a post to capture. | Deduplicated by the collection operation key; redelivery is safe (already-collected). Invalid payloads are terminated. |
| `steele.v1.content.extracted` | The collector commits an archived post (outbox, same step as the archive operation). | Exact archived artifact reference; consumers re-read and verify the hash. Redelivery is idempotent for indexing. Invalid payloads are terminated. |
| `steele.v1.post.analysed` | Theme and claim results for one post are saved (outbox). | Stable event ID per (theme result, claim result) pair; consumers deduplicate by it. |
| `steele.v1.theme.occurred` | Fan-out of a post-analysed event: one per theme occurrence (outbox). | Stable occurrence ID; duplicate parent delivery is idempotent. |
| `steele.v1.claim.occurred` | Fan-out of a post-analysed event: one per claim occurrence (outbox). | Stable occurrence ID; duplicate parent delivery is idempotent. |
| `steele.v1.research.completed` | A research job reaches a terminal outcome (outbox, with the saved result). | Event ID is the job ID; a redelivered request never repeats the provider call. |
| `steele.v1.research.reindex.requested` | An operator or scheduler requests reconciliation of a route. | Idempotent from the index checkpoint; acked after the pass, redelivered while busy or failed, terminated and recorded when malformed, for an unknown route or when retries are exhausted. |
| `steele.v1.content.captured` | An ingestion source archives an item revision (outbox, same step as the archive operation; the collector emits it with text-ready). | Stable event ID per (namespace, item, exact artifact); re-emitting the same revision is deduplicated. Consumers re-read the archived text by reference. Invalid payloads are terminated. |
| `steele.v1.article.approved` | Exact-version verification approves a draft, or a separate owner authority pins one mechanically valid rehearsal revision (atomic outbox). | Stable event ID per (draft, approval); each destination keeps its own keyed intent and receipt, reuses it on redelivery and reconciles uncertain deliveries before retrying. |
