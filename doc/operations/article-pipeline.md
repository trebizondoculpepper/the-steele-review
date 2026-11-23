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

`verified`, `rejected`, `drafted-unverified` (until the package-draft verifier, #150, lands), `evidence-gap` (no claim had independent evidence; only runs submitted before the non-blocking package contract, #747, stop here. Newer runs record `packageReadiness: non-blocking-v1` and go on to draft, with claim coverage passed to the writer as information) or `failed` with a reason. The output lists the exact theme, claim, coverage, package, draft and verification references and each research job's outcome.

## Model choices

Claim extraction requests at most 32,768 output tokens (also bounded by the
200,000-character stage limit), in both the manual command and article worker.
Other model stages retain their existing limits. Structured claim arrays can
exceed the general provider's 8,192-token default even for a modest transcript;
a response cut off there is invalid JSON, not evidence that the source has no
claims. Attempts remain bounded, and grounding/schema validation is unchanged.

### Recovering a completed extraction failure

A terminal workflow result is retained: ordinary resubmission of that captured
revision returns the existing result. Deploying a fix does not restart it.
Do not alter the source version, delete repositories, or change the normal
`articleRunKey` merely to bypass that protection.

For a controlled rehearsal that failed before any approval or publication,
retain the failed run and its input, confirm there are no later-stage effects,
and explicitly submit the same validated input through the existing Restate
workflow client under an operator-recorded rehearsal key (the normal key plus
a unique rehearsal suffix). Record that key once and reuse it on every retry;
never generate a new key on each delivery. The exact archived artifact and
source version stay unchanged. Saved extraction results can be reused.
Ordinary capture delivery and the standard CLI continue to use the normal key.
This is an explicit operator recovery, not an automatic restart loop or a new
default workflow identity. Coordinate with the rehearsal owner before starting
downstream research, and retain the configured request/cost bounds.

### Provider credit exhaustion (#407)

The monetary control is the model provider's own per-key budget (OpenRouter), managed outside the application; there is no separate spending ledger or dollar gate. When it runs out, the provider returns a typed `credit-exhausted` error (HTTP 402), and the run treats it as an operational block, not an editorial result:

- Model stages (themes, claims, draft, verify) stop at once instead of retrying or reporting `provider-failed`/`malformed-output`. A research job that failed for lack of credit (`budget-exceeded`) stops the run at coverage, so no article is written from a false evidence gap.
- The run ends with the terminal reason `<stage>: credit-exhausted`. Nothing is marked as a finding about the article, and no hot retry loop runs.
- Each occurrence writes a sanitised `provider.condition` line locally (correlation ID, stage, revision; no key, prompt, endpoint or response). Sentry receives an `article.pipeline` milestone at warning level with outcome `credit-exhausted`, at most once per stage per 10 minutes, so a queue of stalled runs cannot flood it.
- The dashboard shows an actionable warning on the Articles list and on the run's trace.

**Recovery.** Add credit or raise the key's limit with the provider first. Then recover each affected revision with the explicit operator recovery above ("Recovering a completed extraction failure"): resubmit the same validated input under one recorded recovery key. Content-addressed stage results (themes, claims, research jobs, packages) are reused, so completed work is not paid for twice. Do not resubmit under a new key per attempt.

### Upgrading the article worker: drain first (#439)

Restate replays each in-flight workflow against its recorded journal. A worker version that adds, removes or reorders journaled operations (for example #439's progress updates) cannot safely replay runs started by the previous version: they fail with journal-mismatch errors. The deployment updates the single worker endpoint in place, so before such an upgrade:

1. Stop new submissions (the capture bridge and dashboard trigger), or wait for a quiet period.
2. Confirm no `ArticleRun` invocation is still running (for example the admin SQL query `SELECT target_service_key, status FROM sys_invocation WHERE target_service_name = 'ArticleRun' AND status <> 'completed'` returns no rows).
3. Deploy the new worker image and re-run `register.sh`, then resume submissions.

If a run cannot be drained, keep the old worker version registered until it completes rather than replacing it in place.

### Stage model selection

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

Run the explicit provisioner with an image that includes it and a broker
credential authorised to manage that consumer. The provisioner refuses a
conflicting consumer without changing it. Then start the bridge with the
runtime credential after Restate and the worker are registered.

```sh
docker compose -f deploy/restate/compose.yaml -f deploy/restate/bridge.compose.yaml run --rm --no-deps captured-bridge node dist/cli/provision-captured-bridge.js
docker compose -f deploy/restate/compose.yaml -f deploy/restate/bridge.compose.yaml up -d --no-deps captured-bridge
```

The source allowlist defaults to empty. Set it to the isolated test source for
the fixture smoke test and enable the live source only after that test passes.
The shared image's default web-server health check is disabled for the bridge
until its role-specific probe is wired.

The bridge keeps its own durable state file. After the final failed submission
attempt it records `capture-bridge:<workflow-key>` with
`retries-exhausted:submission-failed` before acknowledging. Inspect the
record using the operation diagnostic. After restoring Restate, recover by
submitting the original captured event for that exact revision through the
configured bridge. Reusing the workflow key also covers a submission whose
response was lost.

### Limit research requests for a run

New runs research **at most two themes per article by default** (#533): one new research job per selected theme, in the librarian's priority order (themes whose claims most need evidence come first). Saved research for a theme is reused and doesn't count against the limit. Themes beyond the limit are recorded as deferred in the article's selection ledger and reported as gaps.

To change the limit, set `STEELE_RESEARCH_REQUEST_LIMIT` on the capture bridge, or pass `article-run --research-request-limit <n>` for a manual submission. Zero disables new research for the run. The limit is part of the original workflow input, so changing it on a duplicate submission doesn't rerun that revision. A retained recovery keeps its exact recorded prefix.
The shared concurrency cap and the batch deadline still apply independently.

## Approval dispatch and dummy publishers (#314, #315)

The Restate stack also runs these services:

- **`approval-dispatcher`** drains the approval outbox in the article worker's state file to `steele.v1.article.approved` on `STEELE_PUBLICATION`. It uses the event ID as the message ID, so the broker deduplicates repeats. `approval-dispatcher --once` drains once and prints the counts.
- **`dummy-publisher-a` and `dummy-publisher-b`** are placeholder destinations. Each has its own durable consumer (`steele-dummy-publisher-a` or `-b`) and destination name (`dummy-a` or `dummy-b`).
  - Each one re-checks the approval against the stored bytes and writes a receipt marked `simulated` under `publications/<destination>/draft/<publication>/<post>/<revision>/` in the content repository.
  - They make no external calls.
  - A redelivered approval reuses the existing receipt.

Provision the destination consumers explicitly, once:

```sh
STEELE_PUBLISHER_CONSUMERS=steele-dummy-publisher-a,steele-dummy-publisher-b node dist/cli/provision.js
```

## Find activity for one original post

To look up a known post, run
`npm run -s post-trace -- <publication-id> <post-id> --correlation-id`.
This prints just the ID and does not connect to any service. The discovery
milestone includes the same `correlation_id` in local JSON logs, and the
discovery event carries it as `postcorrelationid`.
The existing discovery `correlationid` still identifies the poll batch.
Downstream event producers and logs derive the same post ID from the stable
article identity. Redelivery and edits keep the ID, and workflow records include
`revision` to distinguish the captured text versions. Publisher logs include a
hashed `destination_id` to distinguish independent destinations. These logs
are diagnostics. The workflow journal, outbox, and durable receipts remain
the authoritative records.

To activate remote search, create a Node.js project in Sentry and supply its DSN
privately at runtime as `SENTRY_DSN` to each participating service. The Restate
Compose definitions pass it through. For services deployed independently, set
the same variable in their runtime configuration. A process with a mounted
secret may use `SENTRY_DSN_FILE` instead. Restart the participating services,
run one fixture, and search Sentry Logs for `correlation_id:<copied-id>`.
Confirm one ID links the discovery, collection, bridge, article worker, approval
dispatcher, and both publisher outcomes when those stages participate.

With no DSN, the same milestones appear in local stdout as JSON. Remote
export sends an allowlisted set of pipeline fields with fixed event messages.
Keep local logs for container and broker diagnostics.

## Deployed fixture runner (#319)

Run `node dist/cli/article-fixture-smoke.js <synthetic-post-id>` against the
isolated fixture deployment. Set `STEELE_FIXTURE_DEPLOYMENT=1` and use
separate archive and content repositories named `fixture-archive` and
`fixture-content`. The runner needs their paths, the fixture NATS connection
and `STEELE_CONTENT_STREAM`, and `RESTATE_INGRESS_URL`. It seeds a synthetic
archive record when absent. Use a fresh post ID for each run. The fixture
bridge allows only `substack/steele-fixture` and
`node dist/cli/article-fixture-worker.js` serves the actual workflow stages
with deterministic providers. Use a separate Restate deployment and event
streams with dummy destinations only. The fixture worker refuses OpenRouter
credentials.

The command checks that the workflow key is unused, emits the captured event
over NATS, then attaches to the run started by the bridge. It checks the
verification report against the saved draft and waits for both simulated
receipts with the same full draft hash. The default wait is two minutes.
Set `STEELE_FIXTURE_TIMEOUT_MS` to adjust it. A failure prints only the stage
and outcome. Keep the resulting fixture evidence with the deployment record.

Use the isolated Compose file with a dedicated writable directory, a unique
Compose project name and a pinned image that includes the dummy publishers.
Set `STEELE_IMAGE`, `STEELE_FIXTURE_DIR`, and the owning UID and GID if they
differ from the defaults. From the repository root, run:

```sh
docker compose -p steele-fixture -f deploy/restate/fixture.compose.yaml run --rm smoke fixture-one
```

The stack provisions its own broker and archives and registers the fixture
worker. Keep the fixture data and the run's output for inspection. The
Compose network is internal and exposes no host ports.

## Restate execution UI access (#771, #792)

Restate's bundled UI is served by the admin API, which stays bound to loopback on the host. Operators reach it through small forwarders that bind specific interfaces and forward to the loopback admin port. The deployment doesn't expose the admin port directly.

- **LAN:** a forwarder bound to the host's LAN address only.
- **Remote, for authorised users:** a forwarder bound to the host's Tailscale address only, so the tailnet's access controls decide who can reach it. Tailscale Serve (HTTPS on the tailnet) is the preferred alternative once it's enabled for the tailnet; enabling it is an owner action in the Tailscale admin console.
- **Not public:** neither forwarder binds a wildcard or public address.
- **No restart needed:** adding or removing a forwarder doesn't restart Restate.

The UI and its API can cancel and restart invocations, and they have no login of their own. Anyone the network allows to reach a forwarder can use them, so never bind one beyond the LAN or the tailnet. Actual addresses and ports are kept in private infrastructure notes, not in this repository.

## Release versions (#570)

Every successful build of `main` gets a semantic version, `v0.MINOR.PATCH`.

**How the version is chosen** (`scripts/release/version.mjs`):
- **Baseline:** the commit that added `scripts/release/BASELINE` is `v0.1.0`.
- **Patch, the default:** every later first-parent commit on `main`, including docs and chore merges, bumps the patch number.
- **Minor:** a `Semver: minor` trailer, or a conventional `feat:` subject, bumps the minor number. It's read from the merge commit (which includes the PR title) or from any commit the merge brings in.
- **Breaking (pre-1.0 policy):** a `Semver: major` trailer, or a `type!:` subject, also bumps the minor number while the version is below 1.0.

Only Git history is read. PR labels can be edited after a merge, so they're ignored; otherwise a later edit could change versions that have already been published.

The version is computed from the history itself, not from a counter, so:
- reruns and concurrent runs of the same commit always agree;
- two commits never share a version;
- an older commit can't be released as newer.

A commit whose build fails leaves its version unused.

**What the publish workflow does:**
- **Same image, two tags:** it pushes the image tagged with both the commit SHA and the version. The tags refer to the same image digest, which also carries the `org.opencontainers.image.version` and `revision` labels.
- **Gates first:** nothing is pushed until the existing build, smoke and secret gates pass.
- **No moved tags:** an existing version tag is never moved. A rerun reuses it after checking that the commit tag matches. Runs of the same commit are serialised, and a registry error other than "not found" stops the job.
- **Release job:** a separate job, the only one with `contents: write`, creates the Git tag `vX.Y.Z` on the commit and a GitHub release with generated notes. It first checks that any existing tag already names this commit, and it's skipped when that release already exists.

Deployments keep pinning images by digest, so version tags are for people, not for deployment.
