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

# Verification

`src/drafting/verify.ts` checks one exact draft against its exact brief.

## Deterministic checks

These run first, with no model:

- **Identity:** the draft and brief bytes must hash to the references the draft metadata names. Otherwise the result is `invalid` (`draft-hash-mismatch` or `brief-hash-mismatch`).
- **Original link:** must be the brief's source URL.
- **Citations:** every `[E#]` must exist in the brief.
- **Sources:** each listed source URL must match the brief's evidence, and each quoted source passage must be the evidence passage verbatim.

Any failure is a `redraft`, with specific issues and required changes.

## Verifier review

A separate verifier role with its own prompt (`draft-verifier-v1`) then reviews semantic support against the brief only. It can use the same provider as the drafter, and does no browsing or research.

- Each issue must quote an exact passage of the draft and state the required change. Unanchored issues are dropped and counted.
- A redraft with no anchored issue isn't usable, so it stays pending.

## Verdicts

- `approve`: bound to the draft's hash. `isApprovalValidFor` rejects any changed text.
- `redraft`: specific issues to fix.
- `skip`: a redraft verdict on the final allowed attempt.

An unavailable or malformed verifier leaves the work **pending** and never skips.

## Worker

`VerificationWorker.handle(message)` consumes `draft.ready` and runs one operation per draft hash, verifier model and prompt. It commits the report to `verifications/<publication>/<post>/<sha256>.json` and hands off `org.steele.draft.verified.v1` on `steele.v1.draft.verified`. **Live verifier: unverified**; only fake-verifier tests have run.

# Revision attempts

`RevisionAttemptStore` (`src/drafting/revision-attempts.ts`) saves each drafting and verification attempt: one draft of one brief at one revision number, with its report and decision (#99).

1. **`begin({ post, briefHash, revision, owner })`** is called before any model work. It claims the attempt, keyed by brief hash and revision, and returns one of:
   - `already-recorded`, with the saved record for reuse. This also happens when a previous holder committed the record but stopped before completing.
   - `out-of-order`, while revision n-1 isn't recorded.
   - `claimed`, with a link to the previous record.
2. **`finish(claim, record)`** first checks the claim is still held; a worker whose lease was taken over gets `stale-owner`. It then commits the immutable record to `revisions/<publication>/<post>/<brief>/<revision>/<claim attempt>.json` (one path per claim attempt, so a stale holder's late commit never collides with the current one; only the fenced completion makes a record authoritative), keeping the original brief and every draft and report reference. An identical earlier commit is reused; a conflicting one is refused. Finally it completes the state transition with a pending `org.steele.revision.decided.v1` on `steele.v1.revision.decided`.

No model calls, publishing or consumer loop happen here.
