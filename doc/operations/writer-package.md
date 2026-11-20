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
