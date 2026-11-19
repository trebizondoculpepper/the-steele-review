# Drafting brief

`src/drafting/brief.ts` turns one source post's analysis into an immutable, versioned drafting brief, or into an explicit evidence-gap result.

## Inputs

- **Source:** the post's publication, post ID, URL, source version, archive reference and ingestion reason.
- **Claims:** the grounded claims (#32).
- **Assessments:** one applicability assessment (#39) per claim.
- **Comparisons:** optional historical comparison results (#36).

## Selection

`selectBriefEvidence` is pure.

1. **Provenance check:** every claim, assessment and historical finding must belong to the same source version and archive reference. Any mismatch returns `provenance-mismatch` and saves nothing.
2. **Evidence:** only evidence the applicability assessment *selected* (current, independent, applicable) is included. Each item gets a stable citation ID (`E1`, `E2`, …) with its research entry ID, revision and archive reference, and the exact evidence source. An item cited by several claims appears once.
3. **Claims without support** are listed under `evidenceGaps` and left out of the critique. If no claim has support, the result is `evidence-gap` and no brief exists.
4. **Historical findings** are optional and never block a brief.

## Saving

`saveDraftingBrief` validates the brief against `DraftingBriefSchema` and commits it to `briefs/<publication>/<post>/<sha256>.json`. The path is content-addressed, so a repeat reuses the existing brief.

Only after the commit does it complete a state-controller operation, with a pending `org.steele.brief.ready.v1` event on `steele.v1.brief.ready`. The event is a metadata pointer: the brief's archive reference, counts and the ingestion reason.

No drafting, browsing or publication happens at this step.

# Research coordination

`ResearchCoordinator` (`src/drafting/research-coordinator.ts`) routes one analysed post from its claims to a saved brief. It only routes; the injected research keeper owns research decisions.

## advance(post)

1. **Assess:** the keeper assesses each claim against the existing corpus. A keeper failure returns `retry` and requests nothing.
2. **Request:** a claim with open gaps is a research need, keyed by its normalised statement. The need is requested once (a pending `org.steele.research.requested.v1` on `steele.v1.research.requested`), however many posts or runs ask. The post records itself as a waiter and the call returns `waiting`. Nothing is held open in memory.
3. **Pause:** a need whose research is paused, for example by exhausted provider credit, makes the post `paused`.
4. **Hand off:** once every need is settled, the brief is saved through `saveDraftingBrief`, which hands off `brief.ready` to drafting. Settled means saved, unresolved or failed; failed research leaves the claim as an evidence gap.

## onResearchCompleted(event)

Takes `{ needId, outcome: saved | unresolved | failed | paused, reason? }`. It records the outcome once and re-advances every waiting post.

- A repeated event is a no-op.
- A paused outcome is stored separately, so a later real result supersedes it.

All state lives behind the state controller. Its new read-only `operationStatus` and `listOperations` views let the coordinator observe progress without claiming work. No writing, verification or publication happens in the coordinator.
