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

### Generated article fields (#456)

New package drafts save schema-v2 metadata containing a model-generated `title` (1–200 characters), `subtitle` (1–300), and `excerpt` (1–500), each trimmed and on one line. These are separate from the source title and from the body. The existing evidence-validated summary, responses and context remain the sole body authority, rendered to the `.md` artifact; metadata `body` pins that exact artifact while the legacy `draft` pointer remains available. No publication author or byline is generated.

The first-draft prompt remains `src/prompts/writer/package-explainer.md`, with revision instructions in `package-revision.md`. Schema, template and prompt identities distinguish the new contract from cached earlier output; identical new inputs reuse saved artifacts. Readers still accept saved schema-v1 metadata without inventing missing fields. Generated metadata is untrusted prose and is not approved for delivery merely because the body has passed the current body-only verifier. Exact metadata-and-body verification is a separate prerequisite (#457), followed by destination mapping (#458).

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

