# Run subject research manually

Set `STEELE_CONTENT_PATH` to an existing private content repository directory, `STEELE_CONTENT_REPOSITORY` to its logical name, and `STEELE_STATE_PATH` to the state database path. Supply the approved budget-capped OpenRouter credential through `OPENROUTER_API_KEY` or `OPENROUTER_API_KEY_FILE`.

Build and run the command with a real subject.

```sh
npm run build
npm run research-subject -- --subject 'Example research subject' --json
```

Pass an optional `--question` or `--brief` for a more specific request. Pass `--dossier <id>` to create or revise the explicitly selected dossier. The dossier stores the immutable job reference and preserves earlier entries. An identical request reuses its result.

The command saves `report.md`, `manifest.json`, and available source snapshots in the private Git directory `research-jobs/<job-id>/`. Open the manifest at the commit and path printed by the command. Each archived citation has a snapshot reference. Snapshot JSON retains the original response text and its readable extraction. PDFs and redirects that the current fetcher cannot handle are recorded individually. Citation relevance, source type, and factual support still need review.

The defaults are Sonar Deep Research, a 180-second provider timeout, and 4,000 output tokens. Override with `STEELE_RESEARCH_MODEL`, `STEELE_RESEARCH_TIMEOUT_MS`, and `STEELE_RESEARCH_MAX_TOKENS`. For a one-off run, `--model <id>` and `--timeout-ms <milliseconds>` take precedence over the environment. The timeout must be an integer from 1 to 900,000 milliseconds.

```sh
npm run research-subject -- --subject 'Example research subject' \
  --model perplexity/sonar-deep-research --timeout-ms 900000
```

Retrieval is bounded separately. The completion event remains in the local outbox for dispatch. The manual run requires no broker connection.
