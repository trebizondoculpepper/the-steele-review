# Streams and messages

Generated from `src/events/registry.ts` by `npm run events:reference`. Do not edit by hand.

## Streams

| Stream | Override | Captures | Purpose |
| --- | --- | --- | --- |
| `STEELE_DISCOVERY` | `STEELE_DISCOVERY_STREAM` | `steele.v1.source.detected` | Newly discovered or redelivered source posts awaiting capture. |
| `STEELE_CONTENT` | `STEELE_CONTENT_STREAM` | `steele.v1.content.extracted` | Captured source text ready for indexing and analysis. |
| `STEELE_ANALYSIS` | `STEELE_ANALYSIS_STREAM` | `steele.v1.post.analysed` | Analysis-stage completions: one post-analysed event per post and analysis version. |
| `STEELE_RESEARCH` | `STEELE_RESEARCH_STREAM` | `steele.v1.research.completed` | Research job completions (complete, complete with gaps, failed). |

## Messages

| Subject | Event type | Stream | Producer | Description |
| --- | --- | --- | --- | --- |
| `steele.v1.source.detected` | `org.steele.source.detected.v1` | `STEELE_DISCOVERY` | discover, backfill, retry-collection | A source post to capture. |
| `steele.v1.content.extracted` | `org.steele.content.extracted.v1` | `STEELE_CONTENT` | collect-worker | Captured text archived and ready. |
| `steele.v1.post.analysed` | `org.steele.post.analysed.v1` | `STEELE_ANALYSIS` | announce-post | Theme proposals and claims saved for one post. |
| `steele.v1.research.completed` | `org.steele.research.completed.v1` | `STEELE_RESEARCH` | research jobs (#215) | A research job reached a terminal outcome. |
| `steele.v1.claims.extracted` | — | not provisioned | claim-worker | Claims extracted by the automatic worker. |
| `steele.v1.content.embedded` | — | not provisioned | embedding-consumer | Passages embedded. |
| `steele.v1.research.requested` | — | not provisioned | research-coordinator | Research requested for an analysed post. |
| `steele.v1.brief.ready` | — | not provisioned | brief | Drafting brief saved. |
| `steele.v1.draft.ready` | — | not provisioned | drafting-worker | Draft saved. |
| `steele.v1.draft.verified` | — | not provisioned | verification-worker | Draft verification report saved. |
| `steele.v1.revision.decided` | — | not provisioned | revision-worker | Revision decision recorded. |
| `steele.v1.article.published` | — | not provisioned | publisher-worker | Article published. |
