# Mastra experiment track

This is the Mastra side of the [n8n versus Mastra experiment](../../doc/experiments/n8n-vs-mastra.md) (#911). It's a native Mastra project: workflows are TypeScript in `src/mastra/workflows/`, built with `mastra build --studio`, and served by the Mastra server together with Studio.

- **Versions:** Mastra 1.82.0, CLI 1.38.0 and Node 22.23.4. They are pinned in `package.json`, with `overrides` so that the CLI's deployer and server match the pinned core.
- **State:** LibSQL (`STEELE_EXP_MASTRA_DB`) holds workflow snapshots, run history and traces. Traces come from `MastraStorageExporter`, so Studio and the API can query them.
- **Access:** Studio and the API have **no login**, by owner decision (#930). The only access control is the network boundary: the deployment publishes the port on the private network interface only, never on a LAN, public or tunnelled address. Anyone who can reach it can start, cancel and rerun workflows and read their data, so workflow inputs, outputs and logs must never contain secrets. `/health` is open as before.
- **Local development:**
  ```bash
  npm ci
  npm run dev
  ```
- **Deploy:** run `deploy/deploy.sh`, setting `STEELE_EXP_HOST` and `STEELE_EXP_DIR` from private configuration. It builds the image on the linux/arm64 host and updates the compose stack defined in `deploy/compose.yaml`. That compose file contains only placeholders: the real bind address and directories live in private configuration outside this repository.

## Inspecting runs

| What | How |
|---|---|
| Workflows and their schemas | Studio, Workflows view; or `GET /api/workflows` |
| Start a run | Studio; or `POST /api/workflows/<id>/create-run`, then `POST /api/workflows/<id>/start-async?runId=…` with `{"inputData":…}` |
| Run history, step inputs and outputs, errors | Studio; or `GET /api/workflows/<id>/runs` |
| Traces and durations | Studio, Observability view; or `GET /api/observability/traces` |

## Save Us Now RSS intake (#919)

| Workflow | Use |
|---|---|
| `poll-feed` | Runs on Mastra's scheduler (`STEELE_EXP_MASTRA_FEED_CRON`, default every 30 minutes, UTC) and on demand. It reads the feed once, read-only. The first successful poll records every current item as `baseline` and submits nothing. Later polls return only items that are new or edited since the previous poll. |
| `select-feed-item` | Manual entry: `{"url": "https://saveusnow.substack.com/p/<slug>"}`. This is how an older item the baseline skipped can enter. |
| `feed-status` | Read-only view: the last 10 polls (outcome, HTTP status, counts, error) and the discovered items, optionally filtered by status. |

How discovery works:
- **Identity:** an item is keyed by its canonical post URL. The numeric post ID, and with it the contract's `substack:saveusnow:<postId>`, is recorded whenever the feed reveals it: audio posts' enclosures carry it. Capture (#920) pins it from the post endpoint.
- **Storage:** discovery state is kept by `FeedStore` in its own LibSQL file (`STEELE_EXP_MASTRA_FEED_DB`), so it outlives run-history pruning.
- **Allowed sources:** only the publication host is allowed (`STEELE_EXP_MASTRA_PUBLICATION_HOST`), plus an optional fixture host for bounded tests.
- **Scope:** discovery never fetches posts and never starts writing or delivery.
- **Tests:** `npm test` checks a controlled fixture feed: baseline, unchanged polls, new and edited items, failures, host allowlisting and manual selection.

## Retained source versions (#920)

| Workflow | Contract operation |
|---|---|
| `capture-source` `{"url": …}` | `capture`: fetch one public post and save it as an immutable version. Identical content reuses the existing version. |
| `capture-pending` `{"limit": 1–10}` | Captures items discovery marked as needing capture (new, edited or selected), then clears each flag at the fingerprint that was captured. |
| `list-sources` | `listItems`: each item with its latest version and version count. |
| `list-versions` `{"item": …}` | `listVersions`: every retained version of one item. |
| `read-version` `{"version": …}` | `readVersion`: metadata and usable text, read from storage, never from the source. |
| `export-version` / `import-version` | `exportVersion` / `importVersion`: an import is rejected unless the recomputed hash matches. |

- **Text:** usable text is Substack's supplied transcript when one exists. It is fetched once, and its signed link is never kept. Otherwise the text is the article's plain text. If a post has neither, the version is still saved, with empty text and a `no-usable-text` warning. There is no paid transcription.
- **Medium:** comes from the post endpoint. An uploaded video is `video`, even when the feed shows an audio enclosure.
- **Storage:** versions are stored by `VersionStore` in their own LibSQL file (`STEELE_EXP_MASTRA_SOURCES_DB`), together with:
  - the canonical bundle bytes;
  - the original post JSON, with signed links removed;
  - the transcript JSON;
  - the capture metadata.
- **Immutability:** database triggers refuse any update or delete of a version.
- **Hashing:** the version ID is `<item>@sha256:<hash of the canonical bundle>`, and the tests reproduce the shared fixture's hash.

## Summary and critique (#921)

| Workflow | Use |
|---|---|
| `start-writing` `{"version": …, "mode": "fake" \| "live"}` | Starts a new attempt pinned to that exact retained version. It is also the deliberate rerun, including on an older version: every start gets a fresh attempt ID, `mastra-<UTC>-<hex>`. |
| `retry-writing` `{"attempt": …}` | Resumes an interrupted attempt. Saved model output is reused and never paid for twice. |
| `list-attempts` | Shows each attempt's status, pinned version, model, prompt identity, usage, cost and stopping reason, plus the live call ledger. |
| `read-article` `{"article": …}` | Returns the saved Markdown, the structured output and its provenance. |

- **Steps:** every run shows `pin-source`, then `write`, then `save-article`.
- **Prompt:** the shared `experiments/shared/prompts/summary-critique-v1.md`, loaded at run time. Its identity is `summary-critique-v1@sha256:<file hash>`.
- **Validation and rendering:** output is validated against `article-v1` and rendered with the contract's rules. The shared fixture pair pins the expected Markdown.
- **Model:** fake by default. A live call to `deepseek/deepseek-v4.1-flash` needs all of:
  - `STEELE_EXP_MASTRA_LIVE_MODEL_ENABLED=1` in the private stack configuration;
  - `mode: "live"` in the request;
  - room within `STEELE_EXP_MASTRA_MAX_LIVE_CALLS` (default 1) and `STEELE_EXP_MASTRA_LIVE_BUDGET_USD` (default 0.05).
- **Live call safety:** a live call is recorded as started before it is sent, and it is never resent. An interruption or timeout stops the attempt as `provider-uncertain`.
- **Stopping reasons:**
  - `no-usable-text`, `source-too-large`;
  - `invalid-model-output: …` (the raw output is kept);
  - `provider-uncertain`, `provider-error`;
  - `budget-exceeded: …`, `live-model-disabled`;
  - `prompt-changed-since-attempt-created`.
- **Storage:** attempts and immutable articles are kept by `AttemptStore` (`STEELE_EXP_MASTRA_ARTICLES_DB`). The model key is read from the canonical provider configuration, mounted read-only, on each call.

## Delivery to the shared draft service (#922)

| Workflow | Use |
|---|---|
| `deliver-article` `{"article": …}` | Step `build-request` shows the exact payload: request ID `exp-911:mastra:<attempt>`, the labelled title, the pinned source, the article ID and the payload hash. Step `deliver` calls the shared draft service (#912) and shows the outcome, draft ID, readback and receipt. |
| `list-deliveries` | Recent delivery outcomes and receipts, recorded durably. |

- **Draft only:** the result is an unpublished, editable Substack draft with no email. There is no publishing or announcement step, and Substack authentication and conversion stay inside the draft service.
- **Retries:** a retry of the same attempt sends the same ID and payload. A fresh attempt is deliberately a new, separately labelled draft.
- **Unclear outcomes:** an `uncertain` or unreachable outcome is reconciled through the service and never resent. A `conflict`, `invalid` or `forbidden` response is never retried. Within one `deliver-article` run there are at most 3 tries; a definite `failed` is retried with the same ID inside that bound. Each further run is a deliberate operator action, and every run is recorded (`list-deliveries` shows its tries).
- **Switch:** delivery is refused unless `STEELE_EXP_MASTRA_DELIVERY_ENABLED=1` in the private stack configuration. The service URL and Mastra's own token file also come from private configuration; the draft service stores only the token's hash.
- **Tests:** `test/delivery.test.ts` runs the real `experiments/draft-service` locally with its fake destination. To run it, install that package's dependencies first: `npm ci` in `experiments/draft-service`.

## Shared configuration (#945)

`src/common/config/` reads configuration from one directory, the existing owner configuration root named by `STEELE_CONFIG_PATH` (for example `sources/sources.json`). Callers pass the root, so tests point it at `test/fixtures/config/`. The shared layer handles files and generic validation only. Each consumer declares its own schema as a `ConfigSection` and gets a typed value back, or a `ConfigError` (`no-root`, `outside-root`, `missing`, `unreadable`, `malformed`, `invalid`) that names the file and the location of each problem but never a value. Files are read on every call, so a change applies without a restart.

The Substack poller owns its source settings (`src/feed/substack-sources.ts`). `enabledSubstackFeeds(config)` reads `sources/sources.json` in either existing format (the versioned document or the earlier bare array) and returns the enabled Substack sources with their feed URL and publication host. It validates only the fields it uses and leaves settings owned by other consumers alone. Two optional fields are new: `enabled` (default `true`) and `feedUrl` (an https URL; default `https://<id>.substack.com/feed`). Existing files stay valid without them.

## Collection indexes (#942)

`src/collections/` indexes each Git-backed collection in its own Elasticsearch index. The collections root (`<STEELE_APP_DIR>/collections`) is a Git repository, and each immediate child directory is a collection. Nested directories belong to their parent collection. The real host path stays in the private deployment configuration.

- **Declaration:** each collection commits a `collection.json` holding `mappingVersion` (an integer) and `mapping` (an Elasticsearch mapping). A collection with no valid declaration is reported and left unindexed. The indexer adds a `provenance` object to the mapping and to every document: the collection, the path within it, the Git revision, and the blob.
- **Documents:** documents are the committed `*.json` files in the collection. A document's ID is its path inside the collection. Only committed content is read, never the working tree.
- **Names:** an alias is `<namespace>-<collection>`; the namespace is `STEELE_INDEX_NAMESPACE` and defaults to `steele-review`. The backing index is `<alias>-v<mappingVersion>`, or `<alias>-v<version>-r<n>` for a rebuild at the same version. Directory names are lower-cased and characters Elasticsearch disallows become `-`. Invalid names and collisions are rejected before any index is touched.
- **A pass:** `collectionIndexerFromEnv().reconcile()` discovers collections at HEAD, so a new directory needs no deployment. For each collection it does one of two things:
  - **Rebuild:** this happens on a first build, a new mapping version, an explicit `reconcile(["<dir>"])` or `reconcile("all")`, a missing index or alias, or a history rewrite. The indexer builds a new backing index and points the alias at it only once that index is complete.
  - **Incremental:** otherwise it applies the Git changes since the checkpoint, the same catch-up pattern as #250.

  Passes are idempotent. Run one after each commit notification and on a schedule; a missed notification is caught up by the next pass. Run one pass at a time.
- **Recovery:** every path an unfinished pass may have written stays in the checkpoint until a pass succeeds, and is then reconciled against HEAD: indexed if present, deleted if absent. Repeated failures or a reset history therefore cannot leave stale documents. A build that fails keeps its unfinished index as staging and reuses it on the next attempt, so a document that keeps failing costs one index, not one per pass.
- **Connection:** the Elasticsearch connection is read from the configuration directory on every pass, from `elasticsearch/connection.json` (`{"url": ..., "apiKeyFile": "elasticsearch/api.key"}`; the key file is optional). A rotated key applies on the next pass, and nothing is cached between passes.
- **Checkpoint:** a JSON file, `<STEELE_APP_DIR>/state/collection-index.json`, with no SQLite. It moves forward only after every change in a collection has succeeded.
- **Safety:** nothing outside the namespace is created, written or re-pointed. Nothing is deleted: a rebuild keeps the previous backing index, and a collection removed from Git keeps its index and is reported.
- **Live test:** `STEELE_TEST_ELASTICSEARCH_URL=http://127.0.0.1:9200 npx tsx --test test/collections-live.test.ts` runs the adapter against a disposable cluster. Never run it against a shared cluster.
