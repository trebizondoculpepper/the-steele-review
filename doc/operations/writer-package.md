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
