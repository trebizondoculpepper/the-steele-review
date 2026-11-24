# Corpus Refinement: first archive experiment (2026-11-24, #832)

One bounded batch of archived claims was run through the two-call baseline: one model call groups claims into ideas, and one groups the accepted ideas into underlying ideas. Each call goes through the composed model stage (#833) on the deployed worker (v0.1.17). Article and publishing flows were not involved.

## Contents

- [Run](#run)
- [Results](#results)
- [Review](#review)
- [Viability](#viability)
- [Recommended next steps](#recommended-next-steps)

## Run

```text
corpus-refine --run-id exp-832-a --mode archive \
  --posts saveusnow/these-covert-5g-weapons-deployments,saveusnow/military-electronic-weapons-on-your,saveusnow/a-weaponized-transport-network-gateshead \
  --max-claims 45 --max-chars 30000 --wait
```

| | |
|---|---|
| Batch | 45 claims included (15 from each post, round-robin); 181 deferred and recorded; no posts missing |
| Coverage | from the latest saved librarian record per post; none of the 45 was marked covered |
| Model | `openrouter/openai/gpt-6.2-sol` |
| Prompts | `corpus-refinement-map-claims-to-ideas-sha256:7a9fa1d1…`, `corpus-refinement-map-ideas-to-underlying-ideas-sha256:60f611e3…` |
| Calls | 2, one per mapping, each a named Restate step |
| Elapsed | 32.3 seconds, end to end |
| Cost | **estimated** at about $0.08 (about 30k characters in and 10k out per call, at $2/$10 per million tokens). The key's billed-usage counter had not updated when this was written, so no measured figure is available. |
| Saved results | prototype repository `corpus-refinement/exp-832-a/{check-coverage,map-claims-to-ideas,map-ideas-to-underlying}.json`. Each records accepted records, issues, prompt identity and model. |

## Results

**Claims to ideas:** 45 ideas accepted, 0 issues. **Every idea holds exactly one claim**: the first stage restated each claim neutrally (for example "allegedly", "the author suggests") and grouped nothing. All quotations validated verbatim against the claim or its saved utterance.

**Ideas to underlying ideas:** 14 accepted, 1 issue. The validator rejected a group that reused an idea already placed in another group (`idea-in-two-groups`). Examples:

- **underlying-01, "Transport infrastructure allegedly conceals electronic weapons":** 5 ideas from **all three posts**. This is the **repeated proposition**, recognised across posts and phrasings.
- **underlying-07, "Traffic-sensing equipment can allegedly disrupt normal bodily or cognitive functioning":** heart attacks, forgetting and brain interference, grouped together.
- **underlying-13 and underlying-14 (surveillance) kept apart from underlying-01 (weapons):** "the technology can be used for spying but is not itself a weapon" stayed distinct from "the infrastructure conceals weapons". This is the **superficially similar but distinct** case, handled correctly.
- **Weak groups:** underlying-06 ("some bus crashes were serious") and underlying-15 ("the military document does not mention 5G", paired with an idea about deleting documents) add little or pair loosely.

## Review

- **Would the groups support a cited comparison?** The underlying groups mostly would. They cite exact ideas, and each idea cites exact claims with verbatim quotations, so a writer could say "this proposition recurs across three posts" and cite each instance. underlying-01, -07, -10 and -12 are good examples.
- **Main weakness: the first stage does no work.** A 1:1 claim-to-idea mapping means the "idea" layer only restates claims. All the merging happened in the second call. A real corpus will have many near-duplicate claims, and without merging at the idea level the second stage's input grows linearly.
- **The safeguards held:** the evidence and overlap checks caught the one bad group. No fabricated quotations passed.
- **Coverage was uninformative here:** none of these claims had a saved "covered" status, so the coverage check excluded nothing. A batch with covered claims is still needed to exercise it.

## Viability

The two-call baseline is **viable to keep developing**:
- it's fast (about 30 seconds) and cheap (cents per batch);
- it's durable (Restate steps, recorded calls, versioned artifacts);
- its output is checkable;
- the second stage already finds cross-post repetition and keeps similar-but-distinct propositions apart.

It isn't yet useful as a catalogue, because the first stage doesn't group.

## Recommended next steps

1. **Fix the first stage's prompt first, as a small ticket.** Require claims that assert the same proposition to be merged, and report how many claims each idea absorbed. Re-run the same batch (`exp-832-b`) for a direct comparison.
2. **Add a check** that flags a near-1:1 claim-to-idea ratio as a stage-quality issue.
3. **Run a batch that includes covered claims,** to exercise the coverage step.
4. **Capture billed usage per call** in the stage artifact (OpenRouter generation IDs), so cost is measured rather than estimated (see #801).
