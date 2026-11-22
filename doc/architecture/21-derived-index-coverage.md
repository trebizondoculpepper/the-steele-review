# Derived index coverage for reusable corpus artifacts

Status: implementation inventory for #523 (design preparation; no paid backfill is
authorised by this document).

Git remains the versioned authority for every artifact listed here. Elasticsearch
holds only derived, rebuildable projections. No projection may become a second
source of truth, and rebuilding must not rerun extraction, research or any paid
model call.

## Current coverage (grounded in code)

| Artifact (Git authority) | Producer | Index today | Stable identity | Version carried | Gap |
|---|---|---|---|---|---|
| Archived source text / transcript | `src/collection/worker.ts` → `substack/<pub>/<post>/collected.json` | `steele-source-text-v1` (`src/content/fulltext-document.ts`, `src/collection/indexing-handler.ts`, `index-catchup.ts`, `index-replay.ts`) | `substack:<publicationId>:<postId>` | `sourceVersion` (text hash), `schemaVersion` | None for the retained text; acquisition metadata is projected with it |
| Accepted claim occurrences | `src/analysis/grounded-claims.ts` | `steele-claim-occurrences-v1` (`src/analysis/claim-occurrence.ts`, `occurrence-indexer.ts`) | occurrence ID (`sha256:` of the occurrence) | extraction `schemaVersion`, prompt/model identity on the saved record | Claim *items* (revisable `claims/claim-<key>.json`) are not projected; only occurrences are |
| Per-post theme proposals | `src/analysis/theme-proposals.ts`, `theme-extraction.ts` | `steele-source-themes-v1` (`THEME_INDEX_V1`) | `sourceId` (publication/post) | extraction timestamp + artifact hash as index version | Proposals are one document per post, not per proposal; proposal identity is not independently addressable |
| Research entries (saved findings) | `src/research/research-store.ts` | `steele-research-v1` (`RESEARCH_INDEX_V1`) | `entryId` | `revision` | None for entries; dossiers are separate (below) |
| Research collection documents (reports, dossiers, briefs) | `src/research/research-index.ts` | `steele-research-collection-v1` | corpus document ID | revision | Current projection only; superseded versions are retained in Git but not queryable |
| Canonical themes | `src/research/theme-store.ts` (`canonical-themes/<id>.json`) | **none** | theme ID | n/a | Not indexed at all |
| Reusable theme mappings + supersessions | `src/research/theme-mappings.ts` | **none** | mapping key + scope; supersession `from`→`to` | mapping `decidedAt`, supersession events | Not indexed; the dashboard scans Git |
| Writer packages and briefs | `src/drafting/writer-package.ts`, `src/drafting/brief.ts` | **none** | package/brief artifact reference | exact `Ref` in Git | Not indexed |
| Drafts (initial and revisions) | `src/drafting/package-draft.ts` | **none** | `Ref` (repository/commit/path/hash) | exact `Ref`; revision chain in metadata | Not indexed; dashboards scan `articles/` |
| Verifier reports + unresolved wrappers | `src/drafting/package-verify.ts` | **none** | report `Ref`; bound to exact draft hash | exact draft/publication `Ref`, prompt/model identity | Not indexed; review history scans `verifications/` |
| Editorial decisions | `src/drafting/editorial-decision.ts` | **none** | request ID + exact draft identity | immutable decision record | Not indexed |

Deletion and supersession today: source and occurrence indexes support delete on
archive removal (`src/collection/index-catchup.ts`, `index-replay.ts`). Research
documents are re-indexed by revision. Nothing indexes canonical themes, mappings,
briefs, drafts or verifier outcomes, so deletion/supersession is undefined for
those projections because they do not exist yet.

## Proposed contracts for the gaps

All new projections reuse the existing `ElasticsearchController` and logical
index families; one index per artifact family, never one per article. Every
document carries `repository`, `commit`, `path`, `hash`, `schemaVersion` and a
`logicalId`, so a hit always names the exact Git version it was built from.

### 1. Canonical theme catalogue (families: `steele-canonical-themes-v1`)

- `logicalId`: canonical theme ID; document: `id`, `title`, `description`,
  `createdAt`, exact `Ref`.
- Query fields: title/description text, ID keyword. Research coverage is **not**
  stored here; it is derived from dossiers and may be computed by the reader or a
  separate dossier projection, so an unresearched theme remains discoverable.
- Mapping projection (same family or `steele-theme-mappings-v1`): mapping key,
  normalised scope, assessed proposal wording/description, current canonical ID
  (supersession-resolved), exact `Ref`, deciding post and timestamp. Supersession
  events are stored as separate documents keyed by `(key, scope, from, to)` so
  the redirect graph is reconstructible without inference.
- Idempotent replay: every document is keyed by its Git `Ref` hash; supersession
  resolution is applied when reading, never baked into the mapping document.

### 2. Editorial artifacts (families: `steele-drafts-v1`, `steele-verifications-v1`)

- `logicalId`: draft `Ref` hash for a draft; report `Ref` hash for a verifier
  pass. Documents include the post, the exact draft/publication reference, the
  revision number, prompt/model identity and outcome, but never the full draft
  body or hidden model reasoning.
- Current projection: one searchable row per artifact version with
  `isCurrentForPost` updated when a newer version is indexed. Older rows remain
  retrievable and stay bound to their exact draft, so an old approval or review
  cannot be read as applying to a newer text.
- Unresolved wrappers are projected as their own typed document referencing the
  wrapped report; they are never projected as a model review.

### 3. Lifecycle, deletion and rebuild

- Updates are driven by committed Git changes (the existing `changesSince`
  checkpoint pattern) with durable per-family checkpoints; the checkpoint
  advances only after every changed artifact succeeded.
- Deletions remove the derived document; supersession keeps the old mapping
  document and adds a redirect document. A restore re-derives from Git.
- Replay is idempotent: re-indexing the same `Ref` hash produces the same
  document and no duplicate.
- A rebuild command re-derives a family from Git without model calls and is the
  recovery path for a lost or corrupted index. Indexing never triggers
  embeddings or paid work; any future embedding is a separate explicit
  projection with recorded model and input identity.

## Synthetic acceptance for the follow-up implementation

- Duplicate change events for one artifact produce one document.
- Interrupted replay resumes from the last good checkpoint and converges.
- A changed version adds a new document and moves `isCurrentForPost`; the old
  document stays bound to its own draft.
- A deleted artifact's document disappears; restoring it re-derives the same
  document.
- A superseded mapping resolves to the current canonical theme while the
  original mapping document is still retrievable.
- Rebuilding from Git reproduces identical document IDs and no model call is made.

## Follow-up tickets

- #626 — canonical themes and reusable theme mappings projection.
- #627 — drafts and verifier outcomes projection with exact-version provenance.
- #628 — shared durable replay, deletion/supersession and rebuild lifecycle.

Each is separately estimated; this document does not authorise a paid backfill.
