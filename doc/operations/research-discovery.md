# Durable research discovery

Research discovery saves private returned data before citation URL processing. Its logical request ID is independent of the discovery processor identity. The latter includes the stage version, explicit model, content-hashed prompt identity and bounded generation/response parameters; it contains no environment, credential, connection URL or headers.

Each new discovery version has an immutable directory under `research-discovery/<request-id>/<discovery-id>/`:

- `input.json` pins the logical request and processor.
- `response.base64` retains the bounded successful HTTP response bytes losslessly (with encoding, decoded byte length and hash); UTF-8 callback implementations may use `response.txt`. Capture occurs before JSON or schema interpretation. Adapters without a raw-response hook use an explicitly labelled `adapter-return.json`; that is not an original provider envelope.
- `returned.json` pins the body, representation, receipt time and complete/partial transport status.
- `fenced.json` records that the returned response was retained while the caller still held an unexpired capture lease.
- `result.json` records captured, invalid or quarantined status, with separate validation and completion markers.

Subsequent stages use the typed `readResearchDiscovery` reader. It verifies artifact hashes, request/processor identities and the fenced body before returning report text, original citation inputs and available usage. Discovery does not establish factual support. Invalid citation URLs, repeated citations and report whitespace remain in the retained response for later processing.

Malformed JSON, invalid selected fields, provider-indicated length limits, interrupted streams and bounded response prefixes remain inspectable as invalid returned data. A late or unfenced body is quarantined; it does not become accepted merely because its lease later expires. Raw bodies are private corpus artifacts and must not enter logs, public issues, error messages or telemetry.

Replay reuses durable discovery. A crash after dispatch with no retained body is uncertain and must not purchase another response. Confirmed pre-response rejection is recorded separately; a subsequent invocation may recover from it, but an ambiguous failure fences later recall. No returned-but-invalid response starts another paid discovery automatically.

Legacy report-only jobs cannot recover a missing original citation envelope, resolved provider metadata or usage by assertion. Existing retained reports stay readable with an explicit limitation. The current whole-job command's terminal/recovery policy is unchanged; helper-level discovery replay is not a claim that the old command resumes every interrupted source-retrieval stage. Staged workflow orchestration is separate work.

## Citation inventory and per-URL retrieval (#591)

After discovery, two named deterministic stages run under the same discovery directory (`src/research/citation-inventory.ts`):

- **Inventory:** `citations/inventory.json` is built once from the exact saved discovery data. It covers provider citations, annotation URLs, search-result URLs and URLs extracted from the report text, each with its origin.
  - **Identity:** every distinct original URL keeps its own identity, anchors included. Fetching is keyed separately by a normalised retrieval key with the fragment removed, so one download can serve several citations without losing a cited section or silently replacing a source.
  - **Unfetchable URLs:** these stay in the inventory with a reason (not a URL, unsupported scheme, or credentials in the URL).
  - **Saved once:** the inventory is written once and reused, never rebuilt from new data.
- **Retrieval:** each retrieval key is fetched independently through the existing public-page controller, which keeps the host, DNS, redirect, time and size rules.
  - **Snapshots:** `citations/snapshots/<id>.json` is saved before the outcome `citations/retrievals/<id>.json`, so a snapshot left by a crash is adopted rather than fetched again.
  - **Permanent outcomes** (archived, unavailable with its HTTP status, unsupported, or not-attempted beyond the configured source limit) are recorded once.
  - **Transient failures** (rate-limited, unavailable, timeout) retry a bounded number of times, then are reported as retryable and never recorded as permanent.
  - **Credit:** exhausted provider credit stops the stage without recording a verdict.
  - **Isolation:** one URL's failure never loses another's download.

## Assembled result (#592)

`assembleResearch` (`src/research/assemble-research.ts`) builds the research result only from exact saved stages: accepted discovery, the citation inventory and the per-URL outcomes. It never runs discovery or downloads again.

- **Output:** it writes the existing `ResearchManifest` and `ResearchResult` contracts, with the report text, under `research-discovery/<request>/<discovery>/assembled/`. Current consumers and dossiers can read them unchanged.
- **Support:** every citation's support is `not-checked`. A retrieved document is not evidence, and support assessment stays a separate boundary.
- **Gaps:** inaccessible, unsupported, not-attempted and pending retrievals, unfetchable URLs, omitted inventory entries and adapter-only citation provenance are listed explicitly, and any of them makes the outcome `complete-with-gaps`. "Retrieval complete" never means "research sufficient".
- **Completion:** completion and its `research.completed` event are recorded in one state transaction. A failed completion releases its claim for retry. A replay returns the recorded result without rebuilding or emitting again.

## Staged research workflow (#593)

The Restate `Research` service can run one research job as named, recoverable steps instead of one coarse step: `research-discover`, `research-inventory`, `research-retrieve-<round>` (up to three bounded rounds, with backoff between them) and `research-assemble`. A replay reuses each completed step, so a failed URL never restarts discovery and each stage is visible in the invocation journal. Provider failure and credit exhaustion end as a failed result (`provider-error`, `budget-exceeded`), never as an evidence gap.

The contract is chosen per run, at submission, and saved in the run's input as `researchExecution: "staged"`. The dashboard trigger, the captured-content bridge and the `article-run` CLI set it when `STEELE_RESEARCH_STAGED=1`. The article worker always registers both `Research/run` (legacy, one step) and `Research/runStaged`, and a run calls the handler its saved input names. Changing the setting therefore never changes how an in-flight invocation replays. A staged run first reuses any saved terminal result for its job, so a recovery never buys discovery again. Terminal failures are saved with their `research.completed` event; credit exhaustion is left recoverable. Staged reports and snapshots are indexed for research search.

It's off by default because the staged result doesn't yet assess support, and article coverage depends on supported passages.
