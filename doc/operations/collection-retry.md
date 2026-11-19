# Retrying a transcription-unavailable post

A post whose collection ended as `transcription-unavailable` is terminal: enabling a transcriber later does not make it claimable again. Retry one post deliberately with:

```sh
npm run retry-collection -- --post-id <slug>
```

Run it beside the collector, with the same `STEELE_PUBLICATION_URL`, `STEELE_PUBLICATION_ID` and `STEELE_STATE_PATH`, and `STEELE_DISCOVERY_SUBJECT` if the deployment overrides the discovery subject. It needs no broker or search credentials.

What it does:

- Re-reads the post's public metadata from the archive (bounded by `--max-scan`, default 2000) and refuses posts from another publication.
- Asks the state controller to reopen the operation only if it is still `failed` with `transcription-unavailable` and the attempt count it just observed. Completed, in-progress and other failures (for example paid-only) are left untouched.
- In the same SQLite transaction, records a `reprocess` discovery event with a stable ID. The running collector's pending-event dispatcher publishes it, so a crash after reopening cannot lose the retry.
- Grants exactly one more attempt. If that fails again the post is terminal again, and a new retry needs a new deliberate invocation.

Repeating the command is safe: it reports `already-reopened` and records nothing new. Output is one JSON line with the post identity and outcome.

Exit codes: 0 reopened or already reopened; 1 not retryable, not found or lookup failed; 2 usage or configuration error.
