# Claim grouping rerun on the same batch (#849)

Date: 2026-11-24. Run `exp-849-a`, after the claims-to-ideas prompt change and the group-size report (PR #878). Compared with `exp-832-a` (#832).

The same command and inputs were used: the same three posts, the same claim extractions and coverage records, `--max-claims 45 --max-chars 30000`, giving 45 claims, none covered, and 181 deferred. The model was `openrouter/openai/gpt-6.2-sol` for both runs. Only the claims-to-ideas prompt differs.

| | exp-832-a (before) | exp-849-a (after) |
|---|---|---|
| Ideas from 45 claims | 45, every one a single claim | 45, every one a single claim |
| Grouping report | (not recorded then) | `{claims: 45, ideas: 45, sizes: {1: 45}, review: "near-one-to-one"}` |
| Ideas rejected by validation (quotes, IDs) | 0 | 0 |
| Underlying groups | 14 (11 of 2, 2 of 3, 1 of 5) | 13 (12 of 2, 1 of 4) |
| Underlying candidates rejected | 1 | 1 |
| Elapsed time | about 32 s | 40 s |
| Billed usage | about $0.08 (estimated) | not read for this run; the same two calls and similar input, so a similar order of cost |

## What it shows
- **No change in grouping.** The prompt change did not change the first mapper's behaviour: it still maps each claim to its own idea. The new report flags this result as `near-one-to-one` for review, as intended.
- **Fidelity unchanged.** No candidate was rejected for an invented quote or an unknown claim.
- **The ideas are not genuinely distinct.** The second mapper again finds that many ideas share a proposition (13 groups), so the first mapper is under-merging.
- **Wording is not enough.** Prompt wording alone does not move this model to merge in a single pass.

## Recommendation
Stop tuning the single-pass prompt. The designer's planned sequence fits better: map claims to existing ideas (#860), propose new ideas only from what could not be mapped (#859), then compare that two-pass result with this baseline (#862). Both `exp-832-a` and `exp-849-a` serve as the baseline.
