# DeepSeek as a cited research provider: assessment

Status: research only. No provider change, no credential added, no paid request
made. Sources are the official DeepSeek and Perplexity documentation and the
OpenRouter model catalogue, read on 2026-11-22. Published feature claims and
list prices are separated from anything measured; nothing here is a measured
quality result.

Ticket: #759. Related: #758 (bounded Sonar effort experiments), #216 (Sonar
adapter), #210 (staged research), #755 (partial-result warnings).

## Recommendation

**Do not migrate now. Evaluate DeepSeek Flash as a cheaper *discovery* provider
in a bounded head-to-head, then decide.**

DeepSeek is a credible candidate: it now has server-side web search, URL
reading, deep thinking search and structured citations, at token prices roughly
an order of magnitude below Sonar Deep Research. But three facts stop a
straight substitution:

1. **There is no dedicated deep-research model or research-mode flag.** DeepSeek
   documents thinking mode plus web tools; "deep thinking search" is a bounded
   conversation loop (about 20 tool calls), not a long-form research product.
2. **The vendor web tools are a DeepSeek API extension.** OpenRouter's native
   search list covers Anthropic, Google, OpenAI, Perplexity and SpaceXSI;
   DeepSeek is not on it. Through OpenRouter a DeepSeek model gets the generic
   `web` plugin (Exa by default), not DeepSeek's thinking search. Reaching the
   documented behaviour requires the direct DeepSeek API and therefore a new
   credential.
3. **Citations point at answer spans, not source passages.** DeepSeek's
   `citations[].cited_text` is "the answer text of the block up to the
   citation, not text quoted from the source". Sonar's report citations name
   the source URL and title, and the pipeline already re-fetches every URL
   independently. That independent retrieval stays mandatory either way.

If the evaluation shows comparable cited-report quality, the minimal integration
is a second provider **behind the existing discovery boundary only**
(`SonarClient.research()` shape), keeping inventory, retrieval, support judging
and assembly unchanged.

## What DeepSeek actually offers

### Models and endpoints (published)

| Model | Context | Max output | Notes |
|---|---|---|---|
| `deepseek-flash` (DeepSeek-V4.1-Flash-1017) | 1M | 384K | Thinking on by default; vision |
| `deepseek-v4-pro` (DeepSeek-V4-Pro-0813) | 1M | 384K | Thinking; no vision |

Base URLs: `https://api.deepseek.com` (OpenAI format),
`https://api.deepseek.com/anthropic` (Anthropic Messages format). Both publish
a Responses API and tool calling.

### Web tools (server-side, direct API only)

`deepseek_web_search` and `deepseek_read_url` are declared in `tools` and run on
DeepSeek's service; the client executes nothing.

- **Web search, thinking disabled**: model decides whether to search, answers
  with citations. Each call yields `server_tool_use` + `web_search_tool_result`
  and the answer carries `citations` / `annotations`.
- **Deep thinking search, thinking enabled**: several steps of search,
  `open_page` and `find_in_page`, up to about 20 tool calls before answering.
- **URL reading**: with `deepseek_read_url`, the last user message's URLs (first
  10 distinct) can be read. The page text is carried encrypted in `signature`
  and restored on pass-back; `data` is empty for display.
- `tool_choice` cannot force either tool; `tool_choice: "none"` disables them.
- Not billable as tool calls when invoked server-side: only model tokens are
  billed. (As of 2026-11-18 12:00 UTC+8, per the pricing page.)

### Standalone Search & Fetch APIs

For a client-managed loop instead of server tools:

- `POST https://api.deepseek.com/v1/tools/search` — `query` (1–128 chars,
  operators `site:`, `-site:`, `-`, `"..."`, `lang:`, `after:`, `before:`),
  `count` 1–50, `need_content`, `ori_question`, `localization`. Returns
  `results[]` with `title`, `url`, `snippet`, `summary`, `content` (when
  requested), `date`, `authority` 0–4, `rerank_score` 0–3.
- `POST https://api.deepseek.com/v1/tools/fetch` — `url` (HTTP/HTTPS, no
  credentials, ≤8192 chars). Returns `title` and Markdown `content`.
- Pricing: $0.75 per 1,000 successful requests each; failed, empty and timed-out
  requests are not billed. QPS: Search 100, Fetch 25 account-wide, plus a
  per-domain Fetch limit.
- Errors are OpenAI-shaped; retry only 408/429/5xx, never 402 or other 4xx.

This is a **client-managed research loop**: search, choose URLs, fetch, reason,
repeat. It is not a single research call.

### Reasoning, budgets and completion

- Toggle/effort: OpenAI format `thinking` (enabled/disabled) plus
  `reasoning_effort`; Anthropic format `output_config.effort`; Responses format
  `reasoning.effort` where `none` disables thinking.
- Documented effort mapping: `minimal`→low, `low`→low, `medium`→high,
  `high`→high, `xhigh`→high, `max`→max, `ultra`→max. So six names collapse to
  three levels; asking for `medium` is not a distinct setting.
- Thinking mode ignores `temperature`, `presence_penalty`, `frequency_penalty`.
- Single request is synchronous; streaming exists (SSE with `server_tool_event`
  progress for Chat Completions, typed events for Messages/Responses). No
  background/async job API is documented, so there is no "submit and poll"
  research job to map onto Restate's durable call.
- Completion: Messages `stop_reason` (`end_turn`, `max_tokens`, `refusal`),
  Chat Completions `finish_reason` (`stop`, `length`, `content_filter`).
- Usage: final `usage` includes `input_tokens`, `cache_read_input_tokens`,
  `output_tokens`, `output_tokens_details.thinking_tokens` and
  `server_tool_use` counts. Generation failures can return HTTP 200 with an
  `error` body, so the adapter must inspect the body, not just the status.

### Pricing (published, USD per 1M tokens)

| Route | Input (off-peak / peak) | Output (off-peak / peak) | Cache read |
|---|---|---|---|
| DeepSeek `deepseek-flash` | 0.15 / 0.30 | 0.60 / 1.20 | 0.003 / 0.006 |
| DeepSeek `deepseek-v4-pro` | 0.66 / 1.32 | 1.98 / 3.96 | 0.022 / 0.044 |
| OpenRouter `deepseek/deepseek-v4.1-flash-1017` | 0.15 / 0.30 | 0.60 / 1.20 | 0.003 / 0.006 |
| OpenRouter `perplexity/sonar-deep-research` | 2.00 | 8.00 | — + web search 0.005/request, internal reasoning 3.00 |

Peak hours are 01:00–04:00 and 06:00–10:00 UTC on weekdays; everything else is
off-peak. OpenRouter's DeepSeek prices mirror the direct list price, so the
gateway is not the cost problem — the missing vendor tools are.

## Availability through existing credentials

- **OpenRouter (the current credential)**: `deepseek/deepseek-v4.1-flash-1017`
  and `deepseek/deepseek-v4-pro-0813` are listed with the same token prices.
  The `web` plugin works for any model, but for DeepSeek it is Exa (or another
  engine), *not* DeepSeek's `deepseek_web_search`/deep learning search. So an
  OpenRouter route can search, but not with the documented DeepSeek behaviour.
- **Direct DeepSeek**: required for `deepseek_web_search`, `deepseek_read_url`
  and the standalone Search & Fetch APIs. That is a new account and credential,
  which this ticket explicitly does not authorise.

No credential was read, copied or transmitted while checking this.

## Mapping to the existing research boundaries

The pipeline today: one bounded Sonar call produces a report and citations
(`SonarClient.research`), the raw response is retained as a discovery artifact,
then URL inventory, independent retrieval, support judging and assembly are
separate durable stages (#210, #593).

**Option A — DeepSeek as a second discovery provider (minimal).**

- Add a second implementation of the existing provider port whose `research()`
  calls the direct DeepSeek Messages or Chat Completions endpoint with
  `deepseek_web_search` (thinking enabled for deep thinking search).
- Parse `citations`/`annotations` into the existing citation list, retaining the
  full response through the existing `DiscoveryCapture`. Record model, prompt
  version, effort/budget parameters exactly as the Sonar adapter does.
- Keep the stored prompt file (`src/prompts/research/...`); do not add a second
  prompt for the same stage.
- Preserve configured timeout and output cap as `AbortSignal` and `max_tokens`;
  map effort only through the documented set and refuse unsupported values
  before spending, as `assertResearchEffort` already does for Sonar.
- **No change to inventory, retrieval, support judging, assembly or budgets.**

**Option B — client-managed Search/Fetch loop (larger).**

- Replaces the single discovery call with a search→select→fetch loop. It maps
  naturally onto the existing discovery/inventory/retrieval stages, but needs a
  new planning step and a search client, and it moves more orchestration into
  this repository.
- Defensible later if Option A's source coverage proves too thin; not minimal.

**Non-starters.** Assuming a "research mode" parameter; expecting
`deepseek_web_search` to pass through OpenRouter; treating the standalone Search
API as a drop-in replacement for a reported, cited research pass.

## Comparison with Sonar Deep Research

| Dimension | Sonar Deep Research (current) | DeepSeek Flash + web tools |
|---|---|---|
| Product shape | Dedicated research model returning a long cited report | General model + bounded search loop (≈20 calls) or client loop |
| Inputs | Prompt | Prompt; URLs via `deepseek_read_url` |
| Citations | Structured source URLs/titles per report | URL/title plus an answer-span `cited_text`; no quoted source passage |
| Source passage | Not returned by the API; pipeline re-fetches | Encrypted in `signature` for read links; re-fetch still required for independent evidence |
| Reasoning control | No effort selection exposed on the route | `low`/`high`/`max` (six names collapse) |
| Budgets | Timeout + output cap | Timeout + `max_tokens`; search count is model-chosen |
| Long-running work | Long synchronous call; no documented background mode | Synchronous; no documented background mode |
| Published cost, illustrative pass | ~$0.66 + reasoning tokens for 0.2M in / 20K out / 20 searches | ~$0.04 off-peak for the same token volume; server search not billed |
| Gateway availability | Yes, OpenRouter | Token access yes; vendor web tools require direct API |

The cost illustration is arithmetic on published prices, not a measurement. It
also ignores how many tokens each product actually consumes to reach a useful
report — the main unknown.

**Expected trade-off.** DeepSeek should be much cheaper and probably faster per
pass, with fewer independent sources and weaker citation provenance. Whether it
is *useful* depends on the evaluation, not on the price.

## Proposed bounded evaluation

Use synthetic or public, non-sensitive prompts only. One pass per cell.

| # | Prompt (synthetic) | Purpose |
|---|---|---|
| 1 | "Mark Steele of *Save Us Now*: what has he published about 5G, and how does that differ from Mark Steel the comedian?" | Entity disambiguation required by the ticket |
| 2 | "A local planning application cites a transport assessment that the council register does not list. Find the primary documents." | Primary-source fidelity |
| 3 | "What does the latest official guidance say about a named public-health topic?" | Official-source preference |
| 4 | "Two outlets report different casualty figures for one event. Trace both to a primary source." | Contradiction handling |
| 5 | "Summarise what is known about a fictional local committee." | Negative control: must not invent |
| 6 | "Which organisations funded a named research programme, and what did each publish?" | Multi-entity coverage |

For each cell record:

- route (Sonar; DeepSeek Flash via direct API; optionally DeepSeek via
  OpenRouter + Exa as a control), effort, timeout, output cap, search cap
- completion reason, wall-clock latency, provider-reported usage and cost
- citation count, distinct domains, share of primary/official sources
- resolvability of every cited URL (status, redirect, archived copy)
- whether each citation actually supports the claim it is attached to
  (spot-check against the fetched page, using the existing support-judge)
- number of unsupported or invented claims, and whether a partial result was
  correctly reported

Run each cell three times to see variance. Cap total spend:

- Sonar at ~$0.70/pass × 18 = ~$13
- DeepSeek at ~$0.05/pass × 18 = ~$1
- Keep to **six cells per day** (~$4.30) to stay under the $5/day project cap,
  or run DeepSeek first and only the Sonar cells that matter. Paid authorization
  belongs to #758; coordinate one shared budget and record actual costs.

## If the evaluation succeeds

Open the following as separate, small tickets rather than one migration:

1. A direct DeepSeek credential entry in the existing credential boundary
   (never a copied key in a tracked file).
2. A `SonarClient`-shaped DeepSeek discovery adapter with a recorded effort map
   and raw-response retention.
3. A provider choice per research request, defaulting to Sonar until the
   evaluation is repeated on real articles.
4. Reuse of the existing retrieval/support-judge path; no second verification
   design.

## Synthetic request shape

Illustrative only; no key, no request made. Anthropic Messages format, thinking
plus deep thinking search:

```json
POST https://api.deepseek.com/anthropic/v1/messages
{
  "model": "deepseek-flash",
  "max_tokens": 4000,
  "thinking": {"type": "enabled"},
  "output_config": {"effort": "high"},
  "tools": [{"type": "deepseek_web_search", "name": "deepseek_web_search"}],
  "messages": [{"role": "user", "content": "<synthetic research prompt>"}],
  "stream": false
}
```

Parse `content[]` for `web_search_tool_result` (sources) and `text` blocks with
`citations`; read final `usage` from the response (or `message_delta` when
streaming) and treat a body-level `error` as failure even at HTTP 200.

## Limitations of this assessment

- No paid request was made, so every quality statement is a published claim or
  an inference from the API shape.
- DeepSeek's documentation does not quantify deep thinking search depth, source
  selection policy or typical report length.
- Prices and tool availability change; the pricing page already records one
  billing change (server-side tools becoming token-only).
- The evaluation prompts are synthetic; performance on the actual monitored
  publications is unmeasured.

## Sources

- DeepSeek, Models & Pricing — https://api-docs.deepseek.com/quick_start/pricing
- DeepSeek, Thinking Mode — https://api-docs.deepseek.com/guides/thinking_mode
- DeepSeek, Web Tools — https://api-docs.deepseek.com/guides/web_tools
- DeepSeek, Search & Fetch — https://api-docs.deepseek.com/guides/search
- OpenRouter, Web Search plugin — https://openrouter.ai/docs/features/web-search
- OpenRouter model catalogue (`deepseek/*`, `perplexity/sonar-deep-research`) —
  https://openrouter.ai/api/v1/models
- Perplexity, Pricing — https://docs.perplexity.ai/getting-started/pricing
