# Article pipeline cost audit (2026-11-23, #801)

This audit traces the deployed article pipeline and where its cost comes from. It uses two live runs from 23 November 2026: `ulez-hidden-agenda` (11:30–11:46 UTC) and `states-in-the-us-are-kicking-the` (10:52–11:28 UTC). The evidence is retained artifacts, the Restate journals, the deployed worker settings and OpenRouter's public price list. No prompts or source text are reproduced here, and no paid reproduction was run.

## Contents

- [Summary](#summary)
- [How the costs were measured](#how-the-costs-were-measured)
- [Stage by stage (`ulez-hidden-agenda`)](#stage-by-stage-ulez-hidden-agenda)
- [Reconciliation](#reconciliation)
- [Deviations from the owner baseline](#deviations-from-the-owner-baseline)
- [Recommended order of changes](#recommended-order-of-changes)
- [Smallest next checks](#smallest-next-checks)

## Summary

- **Main cost driver:** Sonar Deep Research accounts for about 60–85% of an article's cost.
  - Each research job costs about **$0.50–0.81**, measured from the provider's reported cost.
  - The number of jobs per article sets the bill. `states-in-the-us…` ran **10 jobs ($6.53)**; `ulez…` ran **3 ($1.77)**.
- **Second-largest cost: the writer**, Claude Opus 5.5 at $4/$20 per million input/output tokens.
  - About $0.7 per article over five calls.
  - Each call resends about 80–105k characters.
  - The first draft hit the output length limit, which cost an extra correction call.
- **Editorial review is within the baseline.**
  - Assessment and judgment make one query per draft revision each, on GPT-6.2 Sol at $2/$10.
  - That is about $0.03–0.08 per call, roughly $0.25–0.5 per article.
- **Pre-writer review (#795/#797) is negligible:** one DeepSeek Flash call per research job, under $0.01 each.
- **Likely cause of the 402 errors (#800):** the shared OpenRouter key has a **$25 daily limit**.
  - At about 15:10 UTC, $20.39 of it was used, leaving $4.61.
  - Once the remaining allowance can't cover a request's `max_tokens`, OpenRouter returns 402 even though the account has a positive balance.
- **Billed cost for OpenRouter model calls is not recorded by the worker.** The article worker never wires `onUsage`, so for those calls only estimates are possible.

## How the costs were measured

| Source | Status |
|---|---|
| Sonar cost per research job | **Measured**: `manifest.provider.costUsd`, as reported by the provider |
| OpenRouter model calls (writer, assessor, judge, claims, themes, support) | **Estimated**: retained request and response sizes ÷ 4 characters per token × list price. Reasoning tokens are **unavailable**, because they aren't retained. |
| Key-level total | **Measured**: OpenRouter key counters (`usage_daily`) |
| Per-run billed totals | **Unavailable**: no usage ledger, and the key is shared with other agents and experiments |

## Stage by stage (`ulez-hidden-agenda`)

| Stage | Model or operation | Calls | Request size (chars) | Cap (`maxOutputChars`) | Cost |
|---|---|---|---|---|---|
| Themes | GPT-6.2 Sol | 1 | small | default | ≈ $0.02 (est.) |
| Claims | GPT-6.2 Sol, 32k-token cap | 1 | about 7k of source plus prompt; output about 58 claims | 32,768 tokens | ≈ $0.10–0.20 (est.) |
| Plan research, coverage, package | local | – | – | – | – |
| Research discovery | Sonar Deep Research | 3 (one per job) | – | provider | **$1.77 (measured)** |
| Source retrieval | local HTTP | about 20 URLs per job | – | – | – |
| Pre-writer review (#795) | DeepSeek Flash, reasoning off | 3 (one per job) | ≤ about 60k | 24k | < $0.01 total (est.) |
| Same-speaker history | GPT-6.2 Sol | 0 this run (all `no-history`) | – | – | $0 |
| Draft | Claude Opus 5.5 | 1 initial + 1 length-limit correction + 1 small correction | 81k, 87k, 1.4k | 40,000 | ≈ $0.39 (est.) |
| Assessment | GPT-6.2 Sol | 3 (one per revision) | about 74k each | 60,000 | ≈ $0.15 (est.), plus reasoning |
| Judgment | GPT-6.2 Sol | 3 (one per revision) | 30–35k each | 40,000 | ≈ $0.10 (est.), plus reasoning |
| Revision | Claude Opus 5.5 | 2 | about 105k each | 40,000 | ≈ $0.31 (est.) |
| **Total** | | **about 20 model calls, 3 Sonar jobs** | | | **≈ $2.9–3.1** (Sonar about 60%) |

For `states-in-the-us…`, Sonar alone was **$6.53 for 10 jobs**. The writer, editorial and claims stages were similar in size to `ulez`, at about $1–1.3, giving a total of about **$7.6–7.9**, with Sonar about 85%.

## Reconciliation

- **The two runs:** the key's `usage_daily` was $20.39 at about 15:10 UTC. The two runs account for about $10.5–11 of that.
- **The rest:** other work on the same shared key, for example verification probes, other agents and experiments.
- **Why it can't be split further:** per-run attribution isn't possible without a usage ledger.
- **Limit:** with a $25/day limit, about **two or three 10-job articles exhaust the key for the day**.

## Deviations from the owner baseline

1. **Research fan-out.**
   - **What happens:** `plan-research` commissioned 10 Sonar Deep Research jobs for one post. The baseline expects roughly one query per stage, and this is the overrun.
   - **Related tickets:** #533 (at most one new research job per article) and #794 (replace Sonar Deep Research).
2. **The writer's first draft hit the length limit.**
   - **What happens:** stop reason `length-limit`, with only 4.8k characters of output. A reasoning model likely used part of the 8,192-token budget for thinking, and the stage then paid for a full correction call: about 87k characters of input on Opus.
3. **Repeated payloads.**
   - **What happens:** every writer revision resends the full package (about 105k characters), and every assessment resends the full post and evidence (about 74k).
   - **Why it's acceptable:** that is by design, since each call is independent. But it is the main per-call cost on Opus and Sol.
4. **No usage ledger.** Without one, cost per stage can't be measured, only estimated.
5. **Hidden retry paths:**
   - **Reviewed and fine:** assessment and judgment make no model retries, and malformed output is recorded and never re-queried (tests in #802).
   - **The extra calls:** the writer's correction path is the only extra model call seen in this run.

## Recommended order of changes

1. **Cap research jobs per article** (#533), for example to one to three. This is the largest saving, about $0.6 per job avoided.
2. **Raise the daily key limit or split keys by role,** so editorial calls aren't refused once Sonar has used the day's allowance (#800).
3. **Record usage** by wiring `onUsage` into a per-stage ledger in the article worker. That gives measured cost per stage and reasoning tokens (one small ticket).
4. **Stop the writer losing its first draft to the length limit:** turn off or bound reasoning, or raise the output cap for the initial draft. That avoids an Opus correction call per article.
5. **Then consider cheaper models** for the assessor and judge, or replacing Sonar Deep Research (#794), measured against the ledger.

## Smallest next checks

- **Reasoning share:** a single OpenRouter `generation` lookup per call would answer it, but generation IDs aren't retained. Adding them to the attempt manifests is part of recommendation 3.
- **What happens at the daily limit:** whether editorial 402s line up with it is shown by the new `providerFailure` record (#802), at the next occurrence.
