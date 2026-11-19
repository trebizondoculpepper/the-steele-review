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
