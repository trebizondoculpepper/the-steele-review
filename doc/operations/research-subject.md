# Run subject research manually

Set `STEELE_CONTENT_PATH` to an existing private content repository directory, `STEELE_CONTENT_REPOSITORY` to its logical name, and `STEELE_STATE_PATH` to the state database path. Supply the approved budget-capped OpenRouter credential through `OPENROUTER_API_KEY` or `OPENROUTER_API_KEY_FILE`.

Build and run the command with a real subject.

```sh
npm run build
npm run research-subject -- --subject 'Example research subject' --json
```

Pass an optional `--question` or `--brief` for a more specific request. Pass `--dossier <id>` to create or revise the explicitly selected dossier. The dossier stores the immutable job reference and preserves earlier entries. An identical request reuses its result.

The command saves `report.md`, `manifest.json`, and available source snapshots in the private Git directory `research-jobs/<job-id>/`. Open the manifest at the commit and path printed by the command. Each archived citation has a snapshot reference. Snapshot JSON retains the original response text and its readable extraction. PDFs and redirects that the current fetcher cannot handle are recorded individually. Citation relevance, source type, and factual support still need review.

The defaults are Sonar Deep Research, a 180-second provider timeout, and 4,000 output tokens. Override with `STEELE_RESEARCH_MODEL`, `STEELE_RESEARCH_TIMEOUT_MS`, and `STEELE_RESEARCH_MAX_TOKENS`. For a one-off run, `--model <id>` and `--timeout-ms <milliseconds>` take precedence over the environment. An absent, empty, or whitespace-only optional `STEELE_RESEARCH_MODEL` uses the default; nonblank environment values are trimmed and validated. An explicit `--model` overrides the environment and must itself be valid, so an empty or malformed override is rejected before a provider call. The timeout must be an integer from 1 to 900,000 milliseconds.

```sh
npm run research-subject -- --subject 'Example research subject' \
  --model perplexity/sonar-deep-research --timeout-ms 900000
```

Retrieval is bounded separately. The completion event remains in the local outbox for dispatch. The manual run requires no broker connection.

## Submitting to the shared workflow (#594)

`research-subject` now submits to the Restate `Research` service by default, rather than running research in its own process. It uses the same scope, shared `sonar` concurrency limit and request/execution path as article research. It needs `RESTATE_INGRESS_URL` and the content store settings.

- **Returns:** the job ID and invocation ID at once, plus a Restate UI link when `STEELE_RESTATE_UI_URL` is set.
- **Repeats:** the call key is the stable job ID, so a repeated submission attaches to the same invocation (`already submitted`) and never buys another discovery.
- **Saved work:** a job whose result is already saved, including results from earlier standalone manual runs, is reported and not resubmitted. `--reprocess <n>` (1 to 4) submits a new durable job: a later pass of the same request, linked to the original job. Earlier results stay untouched, and repeating the same `--reprocess n` reports that job rather than rerunning it.
- **`--wait <ms>`:** waits for the job, bounded. If the wait ends first, the invocation keeps running in Restate. Check it later with `--status`, which reads the saved result only and never submits.
- **`--dossier <id>`:** needs `--wait`, so the finished job can be attached.
- **Model and timeout:** these belong to the worker in this mode, so `--model` and `--timeout-ms` are refused unless you use `--local`.
- **`--local`:** keeps the previous in-process behaviour, with model and timeout options and dossier attachment.

Staged or legacy execution follows `STEELE_RESEARCH_STAGED`, exactly as for new article runs.
