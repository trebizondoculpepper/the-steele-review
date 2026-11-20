# Research index worker

`research-index-worker` keeps the research full-text index (`steele-research-collection-v1` by default; distinct from the research-entry store's `steele-research-v1`) in step with committed revisions of the private content repository (#225).

## What is indexed

Only explicitly identified research documents: dossiers (`dossier/<id>.md`), research reports (`research-reports/**.md` and `research-jobs/<job>/report.md`), job covering notes (`research-jobs/<job>/coverage.md` or `covering-note.md`) and readable source snapshots (`research-jobs/<job>/sources/*.json`). Job requests, results and manifests, the catalogue, claims, extraction results and anything unrecognised stay out of search.

Each document's ID is derived from its path, so a revision replaces the document in place and replaying the same revision rewrites it unchanged. Every document records its exact artifact commit and content hash.

## How it keeps up

Changes to the repository's branch refs wake the worker, but notifications are only a hint. Each pass diffs committed revisions from a durable checkpoint and applies every change, then advances the checkpoint. The checkpoint is a marker document in the same index. A periodic pass (`STEELE_RESEARCH_COLLECTION_INTERVAL_MS`, default five minutes) runs regardless, so dropped or coalesced notifications and downtime are caught up. If the checkpoint is missing or no longer an ancestor of the branch (for example after the index is rebuilt), the pass reindexes every research document and removes any not seen.

Each pass first takes an exclusive lease in the state controller (`STEELE_STATE_PATH`), so a second worker or a `--once` run alongside the daemon skips rather than interleaving writes; the lease is renewed while the pass runs and handed back afterwards. A pass records a pending marker before writing. A failed pass leaves the checkpoint where it was, and the next pass after an interrupted one reconciles in full, so a document written from a newer head and later reverted cannot linger.

## Running

Provision the index once with `provision` (it creates `steele-research-collection-v1` with a strict mapping). Then:

```sh
STEELE_CONTENT_PATH=/data/content STEELE_CONTENT_REPOSITORY=steele-content STEELE_STATE_PATH=/data/state/state.sqlite \
ELASTICSEARCH_URL=... node dist/cli/research-index-worker.js          # long-running
node dist/cli/research-index-worker.js --once                          # one pass, exit 0 or 1
```

Output is JSON lines with counts and commits only.
