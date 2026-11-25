# n8n versus Mastra: source-to-draft experiment contract

Status: draft for #911, 25 November 2026. This is the shared specification for tickets #912–#923. It governs both platform tracks so their results can be compared; it does not select a platform. [Rebuild principles](../architecture/rebuild-principles.md), [AGENTS.md](../../AGENTS.md) and [SECURITY.md](../../SECURITY.md) apply throughout.

## The flow

Each platform builds the same four visible stages, using its own native orchestration, state and interface:

1. **Intake.** Poll the Save Us Now RSS feed. Discover new items, and accept a manually selected item.
2. **Retained content.** Fetch the selected item's public post, then save an immutable source version.
3. **Writing.** Run one bounded model call that turns one pinned source version into a summary and critique article.
4. **Delivery.** Send the saved article to the shared draft service (#912). It creates one unpublished Substack draft, with no email.

Out of scope: research, assessor or judge stages, correction loops, multi-agent delegation, public or scheduled publication, subscriber email, a custom dashboard, and anything from the archived implementation that is not reused through a narrow adapter.

## Source and usable text

- **Feed:** `https://saveusnow.substack.com/feed`, which is public. I verified it on 25 November 2026: 20 items, almost all audio posts. Each audio item's RSS body is a caption of roughly 110–220 characters, so it is not usable text.
- **Post metadata:** comes from the public post endpoint `https://saveusnow.substack.com/api/v1/posts/<slug>`. Record `id`, `slug`, `type`, `audience`, `post_date`, `updated_at`, the byline, and the `podcastUpload` or `videoUpload` ID.
- **Usable text:** comes from Substack's own transcript. It is used when the post's upload has `transcription.status = "transcribed"` and the post's audience is `everyone`. The transcript JSON is fetched once from the `transcription.cdn_url` on the Substack CDN.
  - The CDN URL is signed, so it is an ephemeral credential. Use it for that one fetch and never store or log it.
  - On 25 November 2026 the three newest posts had transcripts of 2,169, 2,709 and 2,578 words.
- **Original medium:** `audio`. The retained text is a transcript, so the article must not describe watching or seeing anything.
- **No usable text:** if a post has neither article text nor a supplied transcript, the run stops with the outcome `no-usable-text`, recorded as a warning. Paid transcription isn't added.
- **Comparison post (pinned for #923):** `https://saveusnow.substack.com/p/if-you-go-to-the-patents-and-the`, Substack post ID `226395148`. It was published on 25 November 2026, is about 15.6 minutes of audio, and has a 2,169-word supplied transcript.
  - The source version is pinned by content hash, not by URL. #923 records the hash, and both platforms must start from that same hash.
  - #923 captures the post once, on one platform, exports that version and imports it into the other platform (`exportVersion`/`importVersion` below). Both stores then hold the identical pinned bundle, whatever Substack changes later.

## Writing step

| Setting | Value |
|---|---|
| Model | `deepseek/deepseek-v4.1-flash` via OpenRouter (pinned ID, not a `~…-latest` alias) |
| Prompt | [`experiments/shared/prompts/summary-critique-v1.md`](../../experiments/shared/prompts/summary-critique-v1.md); prompt identity = `summary-critique-v1@sha256:<hash of the file>` |
| Output | JSON matching [`experiments/shared/schemas/article-v1.schema.json`](../../experiments/shared/schemas/article-v1.schema.json), validated before saving |
| Parameters | `temperature: 0.2`, `max_tokens: 2000`, `response_format: {"type":"json_object"}`, `usage: {"include": true}`; no tools, no web search, reasoning off |
| Input limit | Reject a source text over 60,000 characters with outcome `source-too-large` |
| Timeout and retry | 120 s per call. Live calls are never retried automatically: if a live call times out or loses its connection, the attempt stops with `provider-uncertain`, and any further call is a deliberate fresh attempt that counts against the live budget. Fake-model runs may retry once automatically. |
| Cost cap | Each call is pre-checked against an estimated maximum of USD 0.01 (about USD 0.0006 at current prices) |
| Live budget | One live writing call per platform for #923, two in total. Every other run uses the fake model. The experiment as a whole stops before it would spend more than USD 0.10 on model calls. |

**Prompt layout.** Per the rebuild principles, the new prompt layout is chosen alongside the replacement implementation. For this experiment, shared model-facing prompts and schemas live under `experiments/shared/`. Both platforms load them from there: the n8n track through its version-controlled workflow build, and the Mastra track by importing the files. A platform must not keep its own copy of the prompt text. If a platform is selected, its permanent location is decided then.

The article is rendered to Markdown with this layout, in this order:
1. the summary;
2. "Problems with the argument", one bullet per critique point, each labelled with its category;
3. the conclusion;
4. any warnings, as a closing note.

Rendering is deterministic code, not a second model call. Each platform implements it natively, and a shared fixture defines the expected Markdown.

The prompt's word limits (summary 120–250 words, conclusion ≤ 120) are advisory. Both platforms count words the same way (whitespace-separated tokens after removing Markdown punctuation), record the counts with the article, and add a `length-outside-guidance` warning when a limit is missed. They do not reject the output, so the comparison can report length differences.

Model output that fails schema validation is a visible failure (`invalid-model-output`). It keeps the raw response and its usage, and it is not automatically retried. A deliberate fresh attempt can be started instead.

## Identities

| Identity | Form | Rule |
|---|---|---|
| Experiment | `exp-911` | Fixed for this comparison |
| Platform | `n8n` or `mastra` | Always part of the attempt and delivery IDs, so the two platforms never share a delivery |
| Source item | `substack:saveusnow:<postId>` | The numeric post ID, stable across slug edits |
| Source version | `<sourceItem>@sha256:<hex>` | SHA-256 of the canonical bundle bytes defined below. Identical content captured again reuses the existing version instead of creating a duplicate. |
| Run attempt | `<platform>-<UTC yyyymmddThhmmssZ>-<4 random hex>` | Created by an explicit start or fresh rerun. A retry of the same attempt keeps it. |
| Article version | `<attempt>/article@sha256:<hex of rendered Markdown>` | Saved once per attempt. A retry reuses it instead of calling the model again. |
| Delivery request | `exp-911:<platform>:<attempt>` | Same ID means the same immutable payload. A fresh attempt gets a new ID, and can deliberately create a new, separately labelled draft. |

Draft titles carry a visible label: `[exp-911 <platform> <attempt>] <article title>`.

## Canonical source bundle

The source version hash is computed over one canonical representation, the same on both platforms:

- **Content:** a JSON object with schema `source-bundle-v1` and exactly these fields:
  - `schema`, `item`, `postId` (string), `slug`, `url` (canonical `https://<publication>/p/<slug>`), `title`;
  - `publishedAt` and `updatedAt` (ISO 8601 UTC, millisecond precision, or `null`);
  - `author` (byline name or `null`), `medium` (`audio`, `video`, `written` or `unknown`), `audience`;
  - `mediaUploadId` (or `null`), `textSource` (`supplied-transcript` or `article-html`), and `text`.
- **Text normalisation:**
  - For a transcript, `text` is the transcript segments' text, each trimmed, joined with `\n`.
  - For an article, it is the plain text of `body_html`.
  - In both cases the text is then Unicode NFC with `\r\n` replaced by `\n`, and trailing whitespace removed.
- **Serialisation:** [RFC 8785](https://www.rfc-editor.org/rfc/rfc8785) JSON Canonicalization Scheme: keys sorted, no insignificant whitespace, UTF-8.
- **Not hashed:** capture time, fetch provenance, warnings and the signed transcript URL. These are stored next to the bundle as capture metadata, never inside it.
- **Shared fixture:** [`experiments/shared/fixtures/source-bundle-v1.example.json`](../../experiments/shared/fixtures/source-bundle-v1.example.json) and its expected hash in [`source-bundle-v1.example.sha256`](../../experiments/shared/fixtures/source-bundle-v1.example.sha256). The fixture file is stored already canonical, so its SHA-256 equals the expected hash. Each platform's test parses it, re-canonicalises it with its own code, and must reproduce that hash.

## Retained versions: required operations

Each platform provides these through its native interface (n8n: a manual or webhook-triggered workflow; Mastra: workflow/tool runs or Studio). A documented callable alternative is also acceptable. No custom dashboard.

| Operation | Input | Output |
|---|---|---|
| `listItems` | optional limit (≤ 50) | source items known to the platform, newest first, each with its latest version ID and capture time |
| `listVersions` | source item | all saved versions, each with its hash, capture time, text length and warnings |
| `readVersion` | source version | metadata, provenance and usable text, read from storage without refetching |
| `capture` | source item or post URL on the allowed publication | a new or reused source version |
| `exportVersion` | source version | the canonical bundle bytes plus capture metadata, as one file |
| `importVersion` | an exported file | the same source version ID; rejected unless the recomputed hash matches |
| `startRun` | source version | a new attempt, pinned to that exact version |
| `retryRun` | attempt | resumes that attempt, reusing any completed model output and delivery |
| `rerun` | source version, which may be an older one | a new attempt; the older version is used without refetching |

Retained artifacts (source versions and article versions) are kept in storage that survives container rebuilds and execution-history pruning. The two platforms' stores are separate.

## Delivery request to the shared draft service (#912)

```json
{
  "requestId": "exp-911:n8n:n8n-20261126T101500Z-3f2a",
  "experiment": "exp-911",
  "platform": "n8n",
  "attempt": "n8n-20261126T101500Z-3f2a",
  "title": "[exp-911 n8n n8n-20261126T101500Z-3f2a] …",
  "subtitle": "…",
  "bodyMarkdown": "…",
  "source": { "item": "substack:saveusnow:226395148", "version": "substack:saveusnow:226395148@sha256:…", "url": "https://saveusnow.substack.com/p/…" },
  "article": "n8n-20261126T101500Z-3f2a/article@sha256:…"
}
```

The response carries the delivery status, which is one of:
- `created`
- `existing`, for the same ID and the same payload
- `conflict`, for the same ID with a different payload
- `uncertain`, which needs explicit reconciliation
- `failed`

It also carries the draft ID, a draft readback with unpublished and no-email confirmed, and a receipt ID. Only authorised interfaces receive the private editor URL.

## Visibility and recovery checklist (both platforms)

- Each stage shows its status, start and finish time, inputs and outputs (or artifact references), and errors with a sanitised category.
- The writing stage also shows the model, the prompt identity, and token usage and cost where OpenRouter reports them.
- A stopped run shows why it stopped: `no-usable-text`, `source-too-large`, `invalid-model-output`, `provider-uncertain`, `budget-exceeded`, `delivery-conflict`, `delivery-uncertain` or `provider-error`.
- RSS activation sets a baseline. Items already in the feed are recorded as seen and are not run, and an unchanged feed starts nothing. This is checked with a fixture feed.
- Older-version selection is checked with two fixture versions: restart the storage, then run the older version and show its exact text reaches the writing stage.
- Interruption is checked twice: once after the model output is saved but before delivery, and once after the draft is created but before the receipt is saved. Recovery must not call the model or create a draft a second time.
- Repeated delivery of the same request ID returns the existing draft. A changed payload returns a conflict.
- Secrets never appear in workflow JSON, Git, prompts, execution data or logs. Credentials stay in canonical private configuration. Deployment details stay in the private operations project.

## Common success checklist (#923)

1. Both stacks and the draft service are running in isolation, the owner can reach them privately, and no retired service has been restarted.
2. One manual run per platform starts from the same pinned source version hash, using the same model, prompt and parameters. The result is two separately labelled, unpublished Substack drafts with no email, confirmed by readback.
3. The owner can discover content, list versions, start a selected item, deliberately rerun it and choose an older version. Extra reruns beyond the two live ones use the fake model and fake destination.
4. The recovery checks above pass without any duplicate external creation, and new RSS items are detected without replaying the backlog.
5. The two platforms are compared on:
   - how easily an agent can create, change, deploy and debug workflows;
   - how visible the content flow and artifacts are;
   - how easily an operator can intervene;
   - recovery behaviour;
   - deployment footprint;
   - run duration;
   - measured model cost;
   - how much custom code each needed beyond its native features.

**Decision still open after #923:** the owner chooses the platform, or neither, based on the comparison report. This contract makes no recommendation.

## Ticket map and pickup order

| Ticket | Work | Depends on |
|---|---|---|
| #911 | This contract | none |
| #912 | Shared duplicate-safe draft service | #911 |
| #913 | n8n setup | #911 |
| #914 | n8n RSS intake | #913 |
| #915 | n8n retained source versions | #914 |
| #916 | n8n writing step with historical reruns | #915 |
| #917 | n8n delivery | #916, #912 |
| #918 | Mastra setup | #911 |
| #919 | Mastra RSS intake | #918 |
| #920 | Mastra retained source versions | #919 |
| #921 | Mastra writing step with historical reruns | #920 |
| #922 | Mastra delivery | #921, #912 |
| #923 | Comparison and recommendation | #917, #922 |

After this contract is accepted, #912, #913 and #918 can proceed in parallel.
