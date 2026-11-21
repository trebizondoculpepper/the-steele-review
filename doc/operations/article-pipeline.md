# Unattended article pipeline (Restate)

One trigger runs a captured post through the whole pipeline without a person selecting evidence or running per-stage commands (#243): themes → claims → librarian research plan → research with a durable deadline → coverage → writer package → draft → verification. Nothing is published.

## Running it

`deploy/restate/compose.yaml` runs a pinned Restate server (1.8.1, persistent `restate-data` volume) and the article worker (`dist/cli/article-worker.js`, port 9080) on an internal network. Supply paths, the image and the OpenRouter key file through a local `.env` that is never committed. Use the commit-tagged ARM64 image from GitHub Container Registry as `STEELE_IMAGE`. GitHub Actions builds and publishes it from `main`; the deployment pulls it. Then register the worker and the research concurrency limit once:

```sh
docker compose -f deploy/restate/compose.yaml pull
docker compose -f deploy/restate/compose.yaml up -d
RESTATE_ADMIN_URL=http://127.0.0.1:9070 ARTICLE_WORKER_URL=http://article-worker:9080 deploy/restate/register.sh
```

`register.sh` is idempotent and is the readiness check. It fails unless the admin API is healthy and the registration exposes both `ArticleRun` and `Research`. Rerun it after every worker image change.

Deployment settings:

- Pin `STEELE_IMAGE` by digest (`ghcr.io/...@sha256:...`), not by a moving tag.
- `RESTATE_INGRESS_BIND` and `RESTATE_ADMIN_BIND` default to `127.0.0.1:8080` and `127.0.0.1:9070`. Override them on hosts where those ports are taken, and keep them on loopback.
- `STEELE_UID` and `STEELE_GID` (default 1000) must own the bind-mounted repositories and the state directory.
- The worker gets its own health check, an HTTP/2 probe of `/health` on 9080, because the image default probes the HTTP API on port 3000.
- The worker validates that an OpenRouter key file is present at startup but makes no provider call until a run starts.

Start (or replay) one post:

```sh
STEELE_ARCHIVE_PATH=... STEELE_ARCHIVE_REPOSITORY=... RESTATE_INGRESS_URL=http://127.0.0.1:8080 \
node dist/cli/article-run.js --publication-id saveusnow --post-id <slug> [--deadline-ms 1800000] --wait
```

The run is keyed by publication, post and source version (`articleRunKey`). Triggering the same revision again attaches to the existing run; it never creates a second draft. The worker runs every stage as a journaled step, so a restarted worker resumes after the last completed step.

## Research

The librarian plans a stable list of research requests. Each runs as a durable call to the `Research` service in the `research` scope; the registered rule limits active research jobs to two across all runs, and excess calls wait in Restate. The batch deadline starts when the run is submitted, so queue time counts. At the deadline the run pins the results it has: finished jobs (including partial `complete-with-gaps` results) are used, and unfinished or failed jobs become explicit gaps. A result that arrives later cannot change the pinned evidence or the draft.

## Outcomes

`verified`, `rejected`, `drafted-unverified` (until the package-draft verifier, #150, lands), `evidence-gap` (no claim had independent evidence) or `failed` with a reason. The output lists the exact theme, claim, coverage, package, draft and verification references and each research job's outcome.

## Model choices

`STEELE_MODEL` is the default for model-backed stages; `STEELE_MODEL_THEMES`, `STEELE_MODEL_CLAIMS`, `STEELE_MODEL_WRITER` and `STEELE_MODEL_SUPPORT` override per stage. Research uses `STEELE_RESEARCH_MODEL` (Sonar) with its configured timeout and token limits.

## Starting runs from captured content (#270)

`captured-bridge` (`src/cli/captured-bridge.ts`) consumes `steele.v1.content.captured` (#269) from a durable consumer on `STEELE_CONTENT` and submits one `ArticleRun` per captured item revision. The logic is in `src/workflow/captured-bridge.ts`.

- **What starts a run:** only `live` captures from sources listed in `STEELE_ARTICLE_SOURCES` (comma-separated namespaces such as `substack/saveusnow`; empty means none). `backfill` and `reprocess` captures are acknowledged and skipped, so an archive reload never launches hundreds of paid runs; replay those explicitly with `article-run`. Incomplete captures are skipped too.
- **Identity:** the workflow key is the source, item and source version. Substack keeps its publication and post IDs, so a captured-content event and an `article-run` replay of the same revision share one run. Other sources are prefixed with their kind and suffixed with a hash of the whole namespace (`blog/example-site` becomes `blog-example-site-<hash>`), so `blog/x` and `substack/blog-x` never share a run, and item IDs outside the slug alphabet get a stable hash suffix (`articleRunTarget`).
- **Exact input:** the run carries the event's exact archived artifact reference, and the stages read those bytes (hash-verified) rather than looking up the latest capture. A missing or altered artifact, or one not in the capture-record format, ends the run with a recorded reason. The workflow rejects input whose publication and post do not match the captured source.
- **Acknowledgment:** the event is acknowledged only after Restate has durably accepted the submission or reports the run already exists. If Restate is unreachable the event is negatively acknowledged and redelivered; a bridge crash before acknowledgment is safe for the same reason. Invalid events are terminated.
- **Handoff to publishing:** when verification approves a draft, the workflow records one approved-article event through `recordApproval` and the outbox (#262), and returns its ID as `approvalEvent`. A rejected, unresolved or unverified draft emits nothing.

Configuration: `NATS_URL`, `NATS_TOKEN?`, `STEELE_CONTENT_STREAM`, `STEELE_CAPTURED_CONSUMER` (provisioned separately, filtered to `steele.v1.content.captured`), `RESTATE_INGRESS_URL`, `STEELE_ARTICLE_SOURCES`, optional `STEELE_RESEARCH_DEADLINE_MS` (default 30 minutes) and `STEELE_BRIDGE_RETRY_DELAY_MS`.

### Deploy the capture bridge

Add `deploy/restate/bridge.compose.yaml` to the same Compose project as
`deploy/restate/compose.yaml`. Supply a pinned image and the broker connection
through private deployment configuration. Provision a dedicated durable pull
consumer with explicit acknowledgement, the captured-content subject filter,
and new-only delivery before starting the bridge. Check the consumer's filter
and delivery policy before reusing it.

Start only the bridge after Restate and the worker are registered.

```sh
docker compose -f deploy/restate/compose.yaml -f deploy/restate/bridge.compose.yaml up -d --no-deps captured-bridge
```

The source allowlist defaults to empty. Set it to the isolated test source for
the fixture smoke test and enable the live source only after that test passes.
The shared image's default web-server health check is disabled for the bridge
until its role-specific probe is wired.
