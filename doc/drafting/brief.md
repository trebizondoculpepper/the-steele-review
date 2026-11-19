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

# Drafting

`src/drafting/draft.ts` turns a saved brief into a committed draft.

## Template (`critique-template-v1`)

- **Original post:** the link, from the brief.
- **Summary of the post:** a fair, neutral summary (model prose).
- **Related conspiratorial themes:** model prose; "None identified." when empty.
- **Factual and reasoning errors:** one section per criticised brief claim.
  - The claim's statement, then its exact passage quoted.
  - The model's explanation with `[E1]`-style citation references, and an uncertainty level.
  - The brief's limitations, unestablished points and unresolved research findings for that claim. These are always rendered from the brief, so a qualification can't be dropped.
- **Claims not assessed:** the brief's evidence gaps, stated as not criticised.
- **Sources:** every cited source with title, publisher, dates, URL and exact passage.

## Validation

The model writes only the summary, the themes and one item per criticised claim. An item is rejected, with a typed reason, if it:

- names a claim that isn't in the brief,
- names a claim the brief lists as an evidence gap,
- cites an ID not attached to that claim, or
- repeats a claim.

If nothing supported remains, the outcome is `no-supported-errors` and no draft is written.

## Worker

`DraftingWorker.handle(message)` consumes `brief.ready`. It reads the exact committed brief, runs one operation per brief, model, prompt and template, and commits two files:

- `drafts/<publication>/<post>/<id>.md`: the draft.
- `<id>.json`: the metadata, with the brief reference, source and ingestion reason, model, prompt and template versions, draft hash, citation IDs used, evidence-gap count and rejections.

Messages are acknowledged only after durable state. Provider failures redeliver. No browsing or publishing happens. The drafting model is injected; **live provider: unverified**.
