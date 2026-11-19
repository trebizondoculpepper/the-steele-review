# Listing captured posts

`list-posts` is a read-only inventory of the captured-text archive, used to pick posts for extraction runs (#184).

```sh
STEELE_ARCHIVE_PATH=<archive repository path> STEELE_ARCHIVE_REPOSITORY=<logical name> \
  npm run list-posts -- [--publication <id>] [--limit <n>] [--after <publication/post>] [--complete-only] [--json]
```

The archive path is private deployment configuration; keep it in the private deployment notes, not here.

Each line shows `publication/post`, publication date, `complete` or `INCOMPLETE`, text length, capture method, title and public URL. `--json` prints `{schemaVersion, observedAt, posts, malformed, truncated, next}`.

- Results are ordered by post identity and capped at `--limit` (default 50, maximum 500). When more exist, the output says so; pass the printed cursor to `--after` for the next page.
- `--complete-only` hides posts whose capture is incomplete (for example, missing transcription).
- A record that exists but cannot be read or validated is listed by identity under "unreadable", not hidden.
- The command never creates or modifies the archive. A missing or unreadable archive exits 1 with "archive unavailable", never an empty list. Invalid arguments exit 2.
- Output never includes filesystem paths, service URLs or credentials.
