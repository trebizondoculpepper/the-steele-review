# Bounded gap research

`researchGaps` (`src/research/gap-research.ts`) researches only the explicit gaps left by the applicability assessment (#39), then saves the result as a new or revised research entry through the corpus store (#38).

## Flow

1. **Search:** one query per gap, at most `maxQueries` (default 5). Only HTTPS results are kept, deduplicated, up to `maxPages` (default 10).
2. **Fetch:** each page is fetched, and must come back under the requested URL with non-empty text. Text is truncated to `maxPageChars`.
3. **Reason:** a single call over the fetched pages, fenced as untrusted web data, with a versioned prompt (`gap-research-v1`).
4. **Check citations:** each quote must occur verbatim in a page fetched in this run. Anything else is rejected and counted.
5. **Classify evidence:** pages on the monitored publication's hosts are recorded as `monitored`, which can't confirm its own assertion. Everything else is `external`.
6. **Downgrade unsupported findings:** a `supported` or `contradicted` finding without verified external evidence becomes `unresolved`, with a reason.
7. **Save:** the entry is validated against the research schema and saved with the store's revision check. A claim already in the entry is replaced; other claims are kept.

Every call (search, fetch, reasoning) has a deadline of `timeoutMs` (default 30 s) that applies even if a provider ignores cancellation.

## Outcomes

- `saved`, with the stored entry, the finding, the number of rejected citations and the number of failed fetches.
- `failed`, for search outage, reasoning failure (including exhausted provider credit), malformed output or a revision conflict, with a `retryable` flag. Nothing is saved, so the state stays visible and can be retried.
- When nothing is found or nothing can be fetched, the result is a saved `unresolved` finding that says why and keeps the gaps open.

## Providers

Search, fetching and reasoning are injected. Kagi (search and extraction) and an OpenRouter-hosted model (reasoning) are the intended providers. Their keys, model IDs and spending limits are private configuration and aren't part of this code. **Live providers: unverified**; only controlled-provider tests have run.
