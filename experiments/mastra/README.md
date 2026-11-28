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
- **Names:** an alias is `<namespace>-<collection>`; the namespace is `STEELE_INDEX_NAMESPACE` and defaults to `steele-review`. The backing index is `<alias>-v<mappingVersion>`, or `<alias>-v<version>-r<n>` for a rebuild at the same version. Directory names are lower-cased and characters Elasticsearch disallows become `-`. Invalid names, collisions, and names ending in the reserved backing suffix `-v<n>` or `-v<n>-r<n>` are rejected before any index is touched, so an alias can never equal a backing index.
- **A pass:** `collectionIndexerFromEnv().reconcile()` discovers collections at HEAD, so a new directory needs no deployment. For each collection it does one of two things:
  - **Rebuild:** this happens on a first build, a new mapping version, an explicit `reconcile(["<dir>"])` or `reconcile("all")`, a missing index or alias, or a history rewrite. The indexer builds a new backing index and points the alias at it only once that index is complete.
  - **Incremental:** otherwise it applies the Git changes since the checkpoint, the same catch-up pattern as #250.

  Passes are idempotent. Run one after each commit notification and on a schedule; a missed notification is caught up by the next pass. Run one pass at a time.
- **Recovery:** every path an unfinished pass may have written stays in the checkpoint until a pass succeeds, and is then reconciled against HEAD: indexed if present, deleted if absent. Repeated failures or a reset history therefore cannot leave stale documents. A build that fails keeps its unfinished index as staging and reuses it on the next attempt, so a document that keeps failing costs one index, not one per pass.
- **Connection:** the Elasticsearch connection is read from the configuration directory on every pass, from `elasticsearch/connection.json` (`{"url": ..., "apiKeyFile": "elasticsearch/api.key"}`; the key file is optional). A rotated key applies on the next pass, and nothing is cached between passes.
- **Checkpoint:** a JSON file, `<STEELE_APP_DIR>/state/collection-index.json`, with no SQLite. It moves forward only after every change in a collection has succeeded.
- **Safety:** nothing outside the namespace is created, written or re-pointed. Nothing is deleted: a rebuild keeps the previous backing index, and a collection removed from Git keeps its index and is reported.
- **Live test:** `STEELE_TEST_ELASTICSEARCH_URL=http://127.0.0.1:9200 npx tsx --test test/collections-live.test.ts` runs the adapter against a disposable cluster. Never run it against a shared cluster.

## Git service (#949)

`src/common/git/` is the only place that runs Git. Application modules call typed operations on `GitRepository` and never build Git arguments or import a Git library:

- `resolve(revision)` returns the commit a revision names, or `null` for an unknown ref or an unborn branch.
- `isAncestor(a, b)`.
- `listDirectories(revision, dir?)` and `listFiles(revision, dir?)` list the tree at an exact revision; `listFiles` includes blob IDs.
- `readFile` and `readText(revision, path)` return the content at an exact revision, or `null` when there is no file there.
- `compare(from, to, dir?)` lists added, modified and deleted paths.
- `commit({parent, writes, deletes, message})` makes one commit for all the given writes and deletes.

Commits use Git plumbing, as the earlier GitArtifactStore did: a temporary index, `write-tree`, `commit-tree`, and a compare-and-swap `update-ref`. That means:
- no working tree is touched;
- a concurrent writer causes a `conflict` error rather than a lost commit;
- content identical to the current tree makes no commit (`changed: false`), so repeated polls add no history.

Errors are `GitError` with a category: `not-a-repository`, `conflict`, `invalid-path`, `cancelled`, `timeout` or `failed`. Messages never contain Git's output or paths. Absence is a result (`null` or an empty list), never an error. Calls run the installed Git executable with an argument array, a timeout and an optional AbortSignal. The environment is stripped of every variable that could point Git at another repository, index or configuration. Paths and revisions are validated before Git sees them. A custom `GitRunner` can be injected to observe or fake Git.

The service wraps the Git executable rather than a Git library such as isomorphic-git. The executable is what the deployment already runs, it gives exactly Git's own behaviour, and the plumbing approach is proven by the earlier store.

## Substack poller step (#943)

`src/mastra/steps/poll-substack-feeds.ts` (`poll-substack-feeds`) is a reusable Mastra step; #944 registers it as a workflow. Each run:

- reads the enabled Substack sources from the configuration directory (`sources/sources.json`, see #945);
- polls each source's RSS feed;
- keeps one discovery record per observed item at `feeds/<sourceId>/<itemId>.json` in the collections repository (`STEELE_COLLECTIONS_ROOT`, or `<STEELE_APP_DIR>/collections`).

**Records.** The item ID is the post's slug, which is the stable part of its canonical URL. A record holds:
- the original URL as the feed gave it, and the canonical URL;
- the title;
- the publication date, only when the feed supplies one;
- the post ID and source item, when the feed reveals them;
- the medium;
- the fingerprint used to detect edits.

A record holds no poll time, so an unchanged item is never rewritten.

**Commits.** All new and changed records from a run go into one commit through the common Git service. An unchanged run makes no commit, and a lost commit race is retried against the new head. The first run also commits `feeds/collection.json`, the collection's mapping declaration, so the collection indexer (#942) picks the feeds up. An existing declaration is never overwritten.

**Output.** The step returns:
- `sources`: for each source, its status, a failure category (never a URL or response body), and its item, new, changed and unchanged counts;
- `committed`: the references to the committed records (path, change and commit).

A failing feed is reported and does not discard the other feeds' results.

**Out of scope.** The step does no capture, SQLite, NATS, indexing or publishing. A test checks its imports to confirm this.

## Indexing command and Git hook (#952)

The `steele-collections` command (`cli/`) runs the collection indexer. `npm run pack:cli` bundles it into one file and packs a globally installable tarball; install it with `npm install -g ./cli/steele-collections-<version>.tgz`. It needs Node 22.

- `steele-collections reconcile` runs one indexing pass. It is safe to repeat, because it applies everything committed since the last checkpoint. It is also the recovery command after a failed or missed pass.
- `steele-collections reconcile --rebuild <dir>` (or `--rebuild-all`) rebuilds a collection into a fresh index before switching its alias.
- `steele-collections install-hook [--repo PATH]` installs the repository's `reference-transaction` hook. Its settings are saved beside it in `steele-collections.env` (mode 600), so the hook itself holds no paths or credentials.

The hook runs after every branch update, so it covers both `git commit` and the plumbing commits made by the common Git service (`post-commit` would miss those). It calls `steele-collections reconcile` by name on the `PATH` of the account that runs Git. It never blocks or undoes a commit: if indexing fails, Git keeps the commit and the hook prints the recovery command.

Settings come from the environment, and the hook saves them at install time:
- `STEELE_CONFIG_PATH`: the configuration directory, which holds the Elasticsearch connection;
- `STEELE_APP_DIR` or `STEELE_COLLECTIONS_ROOT`;
- `STEELE_COLLECTIONS_CHECKPOINT`;
- `STEELE_INDEX_NAMESPACE`.

Exit status is 0 on success, 1 when a pass reported failures, and 2 for usage or configuration errors.

Passes take a cross-process lock, so a hook-triggered pass, a manual recovery and a scheduled pass never interleave. The lock is the ref `refs/steele-collections/index-lock` in the collections repository. It points at an owner record (host, PID, token and time), and every change to it is an atomic compare-and-swap. A lock whose owner has exited, or that is more than an hour old, can therefore be taken over by exactly one waiting pass. A pass only ever releases its own lock. The hook starts the pass in the background and waits up to `STEELE_HOOK_WAIT_SECONDS` (20 by default) to report the outcome. A slower pass carries on detached and logs to `steele-collections.log` in the Git directory, so it never holds up the Git operation that triggered it.

`cli/proof-952.sh <elasticsearch-url>` is the end-to-end proof from #952. It must run on the deployment host as the account that runs Git, and the URL is passed in rather than stored. It uses a temporary repository and the `steele-review-proof952` namespace. `cli/proof-952-cleanup.sh` removes that namespace's indexes by exact name.

## Poll Substack Feeds workflow (#944)

The reset pilot registers exactly one workflow, **Poll Substack Feeds** (`src/mastra/workflows/poll-substack-feeds.ts`). Its graph is the Substack poller step alone. It is triggered manually from Studio or the API and has no schedule. It returns the poller's per-source summary and the committed record references. Capture, publishing, messaging and scheduling stay outside it.

In the deployment, the container mounts two directories:
- the owner configuration directory, read-only at `/config`; it holds `sources/sources.json` and `elasticsearch/connection.json`;
- the collections Git repository, read-write at `/collections`.

The indexing checkpoint lives at `/data/collection-index.json`. The image includes the `steele-collections` command, and the hook is installed inside the container with `docker exec <container> steele-collections install-hook`. A poll's commits therefore trigger indexing of the `feeds` collection with no further step.

## Substack content fetcher (#953)

**Poll Substack Feeds** now has two steps: the poller, then `fetch-substack-content`. For each new or changed feed item the poller committed, the fetcher reads the exact committed feed record, fetches the public post, and commits one folder per item in a single commit:

```
raw_content/substack/<sourceId>/<itemId>/
  article.json      the record (indexed as one document)
  thumbnail.<ext>   the cover image, when there is one
  images/<sha>.<ext> images from the article body
  post.raw          the original post JSON, signed links removed
  transcript.raw    the supplied transcript as received, when one was fetched
```

`raw_content/collection.json` declares the collection's strict mapping. The originals use `.raw`, so the indexer never indexes them as documents.

What `article.json` records:
- **Item details:** the original and canonical URLs, the title and subtitle, the publication and update dates, and the medium. `representation` is `article` or `recording`, and the record references the feed record it came from (path and commit).
- **Text:** the article HTML as text. Its `role` is `article` for written posts and `description` for recordings, so it is never mistaken for a transcript.
- **Transcript:** the supplied transcript, kept separate from the description. Its status is `usable`, `unusable`, `missing`, `fetch-failed` (supplied but not downloadable; retried) or `check-failed`. The record also keeps the transcript's language label and the check: model, prompt identity, verdict, usage, and whether the label matched the text.
- **Analysis:** `use` is `article`, `transcript` or `skip`, with a reason when skipped: `transcript-missing`, `-garbled`, `-not-english`, `-fetch-failed`, `-check-failed`, or `no-article-text`.
- **Attribution:** the observed bylines are always kept.
  - A single personal byline becomes the author.
  - If there is no byline, or only the publication's account byline (`sourceAccountBylines`), the source's configured `defaultAuthor` is used.
  - Several bylines leave the author unknown.

  The `basis` field records which of these applied.

Transcript check:
- **Model:** a single small call judges whether the transcript text is intelligible English, using `experiments/shared/prompts/transcript-intelligibility-v1.md` on a bounded sample. It goes through the shared model boundary (`src/common/model/openrouter.ts`), which reads the canonical mounted key. The model is set by `STEELE_TRANSCRIPT_CHECK_MODEL` and defaults to `deepseek/deepseek-v4.1-flash`, whose ID I verified against OpenRouter's model list on 2026-11-28.
- **Provider errors:** a provider error never loses the fetched content. It is recorded as `check-failed`, which is distinct from `unusable`, and is retried when the item is fetched again.
- **No repeat charges:** an unchanged transcript reuses its earlier verdict, so there is no second model call.

Recovery:
- **Retry markers:** a capture that does not complete, because the post fetch, the transcript download or the transcript check failed, leaves a `capture.pending` marker in the item's folder. The marker has no `.json` extension, so it is never indexed.
- **Retries:** every run retries pending items as well as the items newly committed by the poll, at most 10 per run and at most 5 attempts per item. After the fifth attempt the marker is kept, marked `exhausted`, for inspection.
- **Races:** if another run commits a capture of the same item first, this run reports `superseded` and does not overwrite it.

Limits on what the fetcher downloads:
- **Hosts:** images come only from Substack's own hosts, over https.
- **Size and type:** at most 10 MB each, image types only.
- **What is never fetched:** no audio or video is downloaded, and nothing is transcribed.

## Theme proposals (#960)

**Propose Themes** (`proposeThemes`) runs the `propose-themes` step on its own for one retained source. Its input is `{path, commit}`: a `raw_content/.../article.json` and the commit to read it at.

**What the step does:**
- It makes one bounded model call, using `experiments/shared/prompts/theme-proposals-v1.md` and `STEELE_THEME_MODEL`, which defaults to `deepseek/deepseek-v4.1-flash`.
- The input is the source's transcript when analysis uses the transcript, and its article text otherwise. Input is capped at 60,000 characters, and a source marked as skipped makes no call.
- The model proposes up to 8 themes. Each has a title, a neutral description and 1 to 3 evidence quotes.
- Each proposal is validated on its own. Every quote must occur verbatim in the source; a proposal with any invented quote is rejected whole. Duplicate titles are refused. Valid proposals are saved even when others are rejected.

**Where results are saved:**

```
themes/<platform>/<source>/<item>/<operation>/<themeId>.json   one per valid proposal (indexed)
themes/<platform>/<source>/<item>/<operation>/operation.meta   outcome, rejected proposals, warnings, usage, timings
```

**Reuse and identity:**
- The operation ID hashes the exact source blob, the prompt identity and the model. A retry or replay of a completed operation reuses the saved result, with no model call and no commit.
- A failed model call is recorded as `model-failed` and completed by the next run, up to 3 attempts per operation. Output cut off at the token limit counts as a failure (`output-limit`), not as "no valid themes".
- A changed source version gets its own operation.
- Theme IDs hash the source blob and the normalised title, so they are stable across retries.

**Output:** the step returns the operation, the outcome (`proposed`, `partial`, `none-valid`, `skipped` or `model-failed`), the theme IDs and titles, the rejected proposals, warnings, usage and timings.

## Claim utterances (#961)

**Extract Claims** (`extractClaims`) runs the `extract-claims` step on its own for one retained source, given its `{path, commit}`. It is built on the shared extraction operation (`src/extraction/operation.ts`), the same one used by Propose Themes. The operation handles:
- reuse of a completed result for the same source, prompt and model;
- a reservation for each attempt before the paid call, at most 3 attempts;
- recovery from failed or truncated calls;
- results that are never overwritten after a lost race;
- recording outcomes, usage and timings.

**Extraction:** one call, using `claim-utterances-v1` and `STEELE_CLAIM_MODEL`, which defaults to `deepseek/deepseek-v4.1-flash`. It proposes up to 20 utterances, each an exact quote of 8 to 80 words plus a neutral restatement. Each quote must occur verbatim in the source. A candidate that is invented, the wrong length, a duplicate or malformed is rejected, with a reason in `operation.meta`.

**What each saved claim records** (`claims/<platform>/<source>/<item>/<operation>/<claimId>.json`):
- **Location:** character offsets in the whitespace-normalised source. For a transcript it also records the segment range and the start and end times, taken from the retained `transcript.raw`.
- **Speaker, for an article:** the article's resolved author, with its attribution basis.
- **Speaker, for a recording:** the author only when every segment carries exactly one speaker label and it is the same label throughout, with basis `single-speaker-recording`. Otherwise the speaker is explicitly unknown, with the diarisation label of the quote's segments kept.
- **Date:** the source's publication date, when it gives one.
- **Identity:** the source path, commit and blob, the prompt identity and the model.
- **ID:** a hash of the source blob and the normalised quote, so it is stable across runs.

## Summaries (#962)

Poll Substack Feeds now has a third step, `summarise-new-content`, which runs automatically after the fetcher. For every item captured in this run, meaning a new or changed source version that has been durably saved, one bounded model call writes a short, neutral summary. It uses `source-summary-v1` and `STEELE_SUMMARY_MODEL`, which defaults to `deepseek/deepseek-v4.1-flash`. The summary attributes the source's assertions to the source rather than stating them as fact.

The step runs on the shared extraction operation. Each summary is saved at `summaries/<platform>/<source>/<item>/<operation>/<summaryId>.json` and records:
- the original URL;
- the exact source version: path, commit and blob;
- the text type: `transcript` when the transcript is usable; for a recording without one, `description`, and the summary says it describes the recording; `article` for a written post;
- the prompt identity and the model.

The status, usage and timings are in `operation.meta`.

What happens in other cases:
- **No text at all:** recorded as `skipped`, with the reason.
- **Model failure:** recorded as `model-failed`. Every later run also looks for unfinished summaries that still have attempts left, up to 10 per run, and retries them even when the feed brings nothing new. Each source version gets at most 3 attempts.
- **A technical error on one item:** reported, and the other items continue.
- **Replays and interrupted runs:** they reuse the completed summary of the same source version, with no model call.
- **A changed source version:** gets its own summary.
