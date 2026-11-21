# Writer evidence package

`writer-package` turns a saved librarian coverage record (#217) into the evidence package the writer receives (#148, #149).

```sh
STEELE_CONTENT_PATH=... STEELE_CONTENT_REPOSITORY=... \
node dist/cli/writer-package.js --coverage librarian/coverage/<publication>/<post>/<hash>.json
```

It reads every pinned input by its exact, hash-verified version: the coverage record, the theme and claim results, each research job's manifest, each dossier version, and, when `STEELE_ARCHIVE_PATH` and `STEELE_ARCHIVE_REPOSITORY` are set, the source post. The package records the source reference and version, the post's proposed themes, and every accepted claim with the librarian's coverage outcome. Covered claims carry their cited passages and archived source snapshots; gaps stay explicit and are never reclassified.

The package is saved write-once under `writer-packages/<publication>/<post>/<hash>.json`. Rerunning with the same coverage record reuses it; a newer coverage record (for example after a dossier revision) yields a separate package, and older packages stay readable.

Outcomes: `ready` (exit 0) when at least one claim has independent evidence; `evidence-gap` (exit 1) when none does, which is saved so the gap is visible. Missing or mismatched inputs, or research still pending, are refused without saving anything.

## Narrative and movement context (#176)

Pass saved historical comparison results (#36) with `--comparison comparisons/<publication>/<post>/<id>.json` (repeatable). Each is read at its pinned version and must describe this exact source version, or the package is refused. The package's `context.history` keeps the earlier passages as quoted evidence (exact quote, publication date, link and archive reference) and the comparison text as generated, never evidence (`isEvidence: false`), with any conflict rationale or changed circumstances. `context.background` carries independently cited passages from the mapped dossiers' pinned versions as movement background. Either becomes an explicit `gap` with a reason when nothing supports it; nothing is invented. Both are bounded (20 comparisons, 30 background passages). Supplying different context produces a different package.

## Drafting from a package (#149)

```sh
STEELE_CONTENT_PATH=... STEELE_CONTENT_REPOSITORY=... STEELE_ARCHIVE_PATH=... STEELE_ARCHIVE_REPOSITORY=... \
OPENROUTER_API_KEY_FILE=... STEELE_MODEL=... \
node dist/cli/draft-package.js --package writer-packages/<publication>/<post>/<hash>.json --source-url https://...
```

The writer receives the package and the pinned full source text and themes (#164), and writes the `package-explainer-v2` template: original link and a fair summary of the post, its themes, then claim-by-claim responses (supported, contradicted, unsupported or unresolved) with numbered sources. It may leave claims out. Every response is validated against the package before saving: it may cite only that claim's evidence, a gap claim can only be "unresolved" and cites nothing, and unknown claims or evidence reject the draft (one retry). The Markdown draft and its metadata (exact package, source, themes, model, prompt and template versions) are saved write-once under `articles/<publication>/<post>/`. Rerunning with the same package, model and prompt reuses the draft without a model call; a new package or prompt version produces a new draft and older drafts stay readable. An `evidence-gap` package is not drafted. The writer never browses or publishes.

From template `package-explainer-v2` (#176) the draft also has a narrative-development section and a wider-movement section. Each is either supported, citing the package's own historical comparisons (earlier passages quoted with dates and links; the comparison text labelled as analysis, not evidence, with any qualification) or its independently sourced dossier background, or stated as a limitation. A section that claims support without that context, or cites context the package does not hold, rejects the draft.

## Verifying a draft (#150)

```sh
... STEELE_MODEL_VERIFIER=... node dist/cli/verify-package-draft.js --metadata articles/<publication>/<post>/<key>.json --source-url https://... [--revise]
```

An independent verifier stage (prompt `src/prompts/verifier/package-verifier.md`) checks the exact saved draft against the exact package it was written from and the same pinned source and themes. Deterministic checks run first: every cited source must be evidence or background the package holds, every claim heading must be a package claim, and a gap claim must stay "Unresolved". The model then checks fairness of the summary, attribution, quotations, citation support and overstatement, preserved gaps and limitations, and historical and wider-movement statements, classifying each problem as substantive or minor. Approval requires no substantive problem.

The report is saved under `verifications/<publication>/<post>/` and names the draft's exact content hash; any edit to the text invalidates the approval. With `--revise`, a `redraft` verdict sends the substantive passages and reasons back to the writer as a new, separately saved revision, up to two redrafts (the existing revision limit); if the draft still fails, an `unresolved` result with reasons is saved. Nothing is published. In the unattended pipeline (#243) the verify stage runs this loop when `STEELE_MODEL_VERIFIER` or `STEELE_MODEL` is configured.

### Choosing the writer model (#260)

`draft-package --model <openrouter model id>` requests any OpenRouter model for that run; without it the configured `STEELE_MODEL` is used. The model is part of the draft's identity, so different models produce separate drafts and a replay with the same model reuses its draft without a model call. The draft metadata records `requestedModel` and the model OpenRouter reports it served (`resolvedModel`). An unknown or rejected model is reported as `model-unavailable` and is not retried or swapped for another model.

## Original post link (#276)

When the package is built with the archive (as the Restate pipeline and `writer-package` do), `source.originalUrl` and `source.title` are copied from the pinned capture record, the same bytes the analysis used. `draftFromPackage` takes the link from the package: a caller-supplied URL (`draft-package --source-url`, or the workflow's `sourceUrl`) is optional and must match, otherwise the draft fails as `source-url-mismatch` before any model call. Packages built before #276 have no pinned URL; for those the caller's URL is required (`no-source-url` otherwise) and is part of the draft identity. The article opens with an explicit Markdown link, `Original post: [<title>](<url>)`.



## Publication metadata verification (#457)

New verification reads the saved `metadata.fields` and body as one immutable manifest. Schema-v2 reports pin that payload, and the verifier checks every reader-visible factual field against the same pinned source and evidence. Any changed title, subtitle, excerpt, body or pinned metadata version needs a different verification identity. Identical inputs reuse the saved report. Schema-v1 reports remain readable as body-only verification and cannot approve unseen metadata. The Markdown body remains the existing evidence-validated rendering; no second body or title is regenerated during handoff.


## Writer output failures and bounded correction (#524)

A rejected writer response produces a versioned diagnostic tied to the exact writer package, model and prompt. Diagnostics distinguish JSON syntax, structured-schema validation, adapter-confirmed truncation and deterministic evidence validation. They retain attempt number, allowlisted schema issue codes/known field paths, output hash and character count. They never retain rejected model text, arbitrary property names, exception messages or provider response bodies. A missing truncation signal is recorded as unknown, not inferred from invalid JSON.

The existing two-call budget is unchanged (the single-attempt CLI option still disables correction). When the first response fails validation, the remaining call receives the original source/evidence plus the rejected response as untrusted data and safe validation feedback. Correction instructions live in `src/prompts/writer/package-output-repair.md`; they cannot weaken grounding checks or independent verification. Exhaustion returns an operational failure with safe diagnostic references; no draft or approval is fabricated.

Valid initial drafts keep their existing cache identity. Repaired drafts have a separate identity including the exact repair prompt content, and metadata records the repair prompt and diagnostic references. Both remain immutable and pass normal exact-payload verification before delivery. Deploy readers/consumers that accept these optional metadata fields before the producing worker. Old failures remain readable, but their discarded response details cannot be reconstructed. An explicit post-fix recovery can reuse its pinned research/package; it must not invent a source version or repeat full research merely to retry writing.

### Private writer attempts

Writer calls require `STEELE_STATE_PATH` as well as the private content repository.
Every returned response is committed unchanged under `writer-attempts/` **before**
JSON, schema, or evidence validation. This includes rejected responses and editorial
revisions. Transport failures without returned text have an explicit no-response
record; interrupted calls never invent a response or automatically repeat the call.

Each attempt has a versioned input record, completion metadata, raw `response.txt`,
and manifest. A separate validation manifest records accepted/rejected status and
safe diagnostic references. Accepted draft metadata links its attempt manifests.
Raw attempts are audit material, not articles, research evidence, or approvals.
Legacy cached drafts remain readable and report retention as `legacy-unavailable`.

A restart reuses the exact committed response and its completion metadata rather
than charging for another call. If the call was interrupted before a response was
committed, automatic processing holds. A late response is retained for deliberate
rescue and cannot become an accepted article automatically. Archive failures stop
processing. Repair and editorial verification budgets remain separate concerns.

`readWriterAttempt` provides typed, hash-verified private inspection;
`renderWriterAttemptText` escapes untrusted text for a private HTML view. Ordinary
CLI/status/telemetry output contains references and allowlisted categories only.
Never copy raw attempts, input prompts, credentials, or private paths into public
issues, source, logs, or Sentry. Raw retention does not bypass independent exact
publication-payload verification.

`draft-package --writer-recovery-id <stable-token>` permits a deliberate new
capture generation only after a confirmed rejection before any returned response
(credit, rate limit, authentication, or invalid request). Reuse the same token
when retrying that recovery. Existing raw output is always reused. Timeouts,
unknown transport failures, and interrupted calls cannot use this mechanism to
silently purchase another response. Workflow entry points do not generate these
operator recovery tokens automatically.

### Mechanical repair policy

`STEELE_WRITER_TURN_LIMIT` sets total writer turns (default **3**: initial output
plus at most two corrections; range 1–10). `STEELE_WRITER_DEADLINE_MS` sets one
shared deadline for that mechanical loop (default 300000 ms, maximum 900000 ms).
The article worker, `draft-package`, and revision-enabled `verify-package-draft`
load these settings. `--single-attempt` can still lower the manual draft budget.
Independent verifier-requested editorial revisions keep their separate bound;
each writer/redraft invocation has its own mechanical policy and private record.

For schema errors confined to title, subtitle, or excerpt, the correction request
contains only the invalid fields, their allowlisted errors, and exact constraints.
Valid metadata, body sections, and citation arrays are not sent to that correction
call and cannot be overwritten by its patch. Unexpected patch keys are rejected.
Every correction response is committed before checking it; a permitted patch is
merged into the retained candidate and the result is committed before full
mechanical revalidation. The excerpt limit remains 500 characters.

Syntax/truncation, nested schema errors, and structural evidence-reference errors
use an explicitly recorded format/schema/evidence fallback rather than pretending
to provide arbitrary nested field-only editing. Private `writer-mechanical-runs/`
records link policy, each turn's mode, raw attempt, derived candidate, diagnostics,
and terminal outcome. `writer-candidates/` holds derived merge artifacts and parent
references, distinct from returned model output and accepted articles. Exhaustion
retains everything without approval. A restarted loop reuses identical saved
responses; it does not buy them again. All successful payloads still require
independent verification of their exact body and publication fields.

Workflow results expose mechanical-run references, not raw output. If mechanical
repair of an editorial redraft fails, the result remains `failed` and retains the
last valid draft and its negative verifier report for inspection. Neither record
is an approval. Deploy updated artifact readers/consumers before the writer that
produces the new optional metadata fields; retain the active workflow endpoint
until existing invocations finish.


## Stable article identity and paths (#578, owner-authorised storage change)

A redraft edits one logical article in place instead of writing a new unrelated document (#488). Two identities are kept apart:

- **Logical article ID:** `article-<24 hex>`, derived only from the publication, the post and an *edition* slug (default `primary`). It survives redrafts and retries. Independent editorial articles about the same source use different editions, so they get different IDs. Helpers: `articleId`, `articlePaths` and `classifyArticlePath` in `src/drafting/article-identity.ts`.
- **Generation identity:** the existing hash of package, model, prompt and revision inputs. It still keys caching and safe retries; it never names the canonical document.

Canonical paths, edited in place, with earlier versions readable at their exact Git commits:

```text
articles/<publication>/<post>/<article-id>/article.md     # body
articles/<publication>/<post>/<article-id>/article.json   # metadata and provenance
```

Synthetic example: publication `example-pub`, post `a-synthetic-post`, edition `primary` gives `articles/example-pub/a-synthetic-post/article-<24 hex>/article.md`.

Existing hash-named drafts (`articles/<publication>/<post>/<32 hex>.md|json`) are unchanged and remain readable by exact commit, path and hash. Nothing is migrated or regenerated, and the two layouts can't collide. Writing canonical documents in place, with expected-version checks, comes in #579. Exact-version approval and delivery come in #580, and the console view of one article with its history comes in #581.
