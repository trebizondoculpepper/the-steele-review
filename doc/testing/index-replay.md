# Archive-to-index replay

`npm run replay-index -- --publication ID --limit N [--post ID ...] [--from ISO] [--to ISO]` rebuilds full-text index documents from collection records already committed to the archive.

It goes through the same projection, mapping and versioned write as the indexing worker. It never fetches sources, transcribes media, deletes indices or publishes events, so it can't trigger downstream work or publication. Each record keeps its own ingestion reason.

## Selection

Selection is always explicit and bounded:

- `--publication`: required.
- `--limit`: required, at most 1,000.
- `--post`: named posts; repeatable.
- `--from` and `--to`: an inclusive publication-date range. Undated posts are skipped when a range is given.

At most 20,000 archive paths are inspected per run.

## Output and exit status

One JSON line: `selected`, `indexed`, `unchanged` (already indexed at this version), `incomplete`, `skipped` (outside the date range), `failed` (path and reason) and `truncated` (the limit stopped the run).

Exit status is 0 when nothing failed, 1 when any record failed, and 2 for a usage or configuration error.

Reruns are safe: index writes are externally versioned, so records already indexed are reported as `unchanged`, and only failed records are retried.

## Configuration

Set through environment variables: `ELASTICSEARCH_URL`, `ELASTICSEARCH_API_KEY` (optional), `STEELE_ARCHIVE_PATH`, `STEELE_ARCHIVE_REPOSITORY`, and `STEELE_FULLTEXT_INDEX` (optional; defaults to `steele-source-text-v1`).

## Incremental catch-up from Git (#250)

After a pinned bulk load (`replay-index --commit SHA --checkpoint PATH`), `catch-up-index --checkpoint PATH [--publication ID]` applies every archive change since that checkpoint's `commit` to the full-text index: added and revised capture records are indexed (versions already indexed are skipped), and records removed from the archive are deleted from the index. The logic is in `src/collection/index-catchup.ts`.

- **Exact reads:** each record is read at the head the pass applies, so later commits cannot leak into it.
- **Checkpoint:** the same JSON file as the bulk load, written atomically. A pass records `pending: <head>` before writing, and only after every change succeeds sets `commit` to that head and clears `pending`. A failed or interrupted pass leaves `pending`, and the next pass reconciles every current record instead of trusting the old diff.
- **Limitation:** the strict index mapping has no generation field, so a full pass cannot find documents for records removed before it started. The archive is append-and-revise, so this is rare; any removal after a successful checkpoint is applied by the next incremental pass.
- **Safe to repeat:** an unchanged archive is a no-op; reruns of the same changes are idempotent.

Tests: `test/collection/index-catchup.test.ts` covers catch-up over several commits (add, revise, delete) from a #249 bulk-load checkpoint, a failed change not advancing, recovery after an interrupted pass, and a publication filter.
