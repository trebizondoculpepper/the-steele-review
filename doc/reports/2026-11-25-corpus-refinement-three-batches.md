# Corpus Refinement on three archived batches (#853)

Date: 2026-11-25. Runs `exp-853-a45`, `exp-853-b45` and `exp-853-c45`, on the existing Corpus Refinement path in archive mode. Model: `openrouter/openai/gpt-6.2-sol` for both stages. Every stage read the pinned reviewed seed catalogue `seed-2026-11-24` (6 entries), saved once in the isolated experiment store. Outputs were written only to that store. The source citations stay pinned in each run's `batch.json` and stage artifacts.

## Batches

There are 17 archived Save Us Now posts with claim extractions. I split them into three reproducible batches and spread related topics across the batches so that some repetition between batches was known in advance. Low-emission zones and ULEZ, the two Epstein posts, electronic weapons, and transport appear in more than one batch.

| Run | Posts | Claims included | Deferred (recorded, not dropped) | Utterance characters |
|---|---|---|---|---|
| a45 | 6 | 45 | 458 | 8,148 |
| b45 | 6 | 45 | 418 | 8,727 |
| c45 | 5 | 45 | 272 | 10,955 |

**Why 45 rather than 75.** The first attempt used 75 claims per batch (`exp-853-a`). Its first-stage call failed with `response-too-large`, because one idea per claim exceeds the step's 24,000-character output allowance. The batches were reduced to 45 claims, the size known to fit from #849. That failed call is the only extra call made.

**Why the second stage was not pooled.** The existing path runs both stages inside each run, and has no entry point that runs only the second stage over ideas pooled from several runs. Each batch therefore ran its own second stage against the same pinned catalogue. Pooling would need a new composable entry point.

## Results

| | a45 | b45 | c45 |
|---|---|---|---|
| Specific ideas from 45 claims | 45 (42 single, 3 of two claims) | 45 (all single) | 45 (all single) |
| Ideas rejected by validation | 0 | 0 | 0 |
| Underlying ideas accepted | 6 | 11 | **0** |
| Reused catalogue entries | 2 | 1 | 0 |
| New underlying ideas | 4 | 9 | 0 |
| Uncertain matches | 0 | 1 | 0 |
| Underlying candidates rejected | 2 (an idea placed in two groups) | 0 | **8 of 8** (`schema:match`) |
| Ideas left ungrouped | 27 | 20 | 45 |
| Claims recorded as rejected | 2 | 0 | 8 |
| Model calls | 2 | 2 | 2 |
| Elapsed time | 46 s | 35 s | 36 s |

Across the three batches there are **16 distinct underlying ideas**, far fewer than twenty. As the ticket says, that is a hypothesis, not a quota.

**Repetition across batches.** `transport-infrastructure-causes-illness` was reused from the catalogue in both a45 and b45. `hidden-weapons-in-transport-infrastructure` was reused in a45. In b45 there was a near match (`roadside-devices-as-weapons`) that was left **uncertain** rather than forced. The other new ideas in b45 overlap a45's themes, for example `transport-changes-as-deliberate-harm`. A pooled second stage could merge those, but per-batch runs can't.

**Merge and split errors.**
- *Under-merging in the first stage* is unchanged from #849: nearly every claim becomes its own idea (132 of 135).
- *Merge errors:* a45 had 2 candidates that put the same idea in two groups, and both were rejected.
- *Truncation:* none at 45 claims. At 75 claims the first stage is truncated (see above).

**Batch c failed silently.** In the second stage of c45, the model produced 8 candidate groups, and every one failed validation on the `match` field (`schema:match`). The run still completed, with 0 underlying ideas and all 45 ideas unplaced. Each rejected candidate is saved with its reason, so nothing is lost, but a whole batch produced no usable output and nothing flagged it beyond the rejection file. This needs a follow-up ticket: either one bounded repair attempt on a schema failure, or a run-level flag when every candidate is rejected.

**Cost.** I didn't read billed usage for these runs. Seven model calls were made in total: two per run, plus the failed 75-claim call. At #849's size, each run costs about $0.08, so the total is roughly $0.3.

## Conclusions

1. Catalogue reuse works when an existing entry fits, and was used in two of the three batches. A near match is left uncertain rather than forced.
2. The first stage still maps almost one claim to one idea. The two-pass design (#860 → #859 → #862) remains the right direction.
3. 75 claims per batch don't fit the first stage's output allowance. Either keep batches at 45 or less, or raise the allowance on purpose.
4. A schema failure that rejects every candidate in the second stage should be flagged, or retried once. Follow-up ticket proposed.
