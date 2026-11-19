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
