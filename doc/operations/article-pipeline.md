# Unattended article pipeline (Restate)

One trigger runs a captured post through the whole pipeline without a person selecting evidence or running per-stage commands (#243): themes → claims → librarian research plan → research with a durable deadline → coverage → writer package → draft → verification. Nothing is published.

## Running it

`deploy/restate/compose.yaml` runs a pinned Restate server (1.8.1, persistent `restate-data` volume) and the article worker (`dist/cli/article-worker.js`, port 9080) on an internal network. Supply paths, the image and the OpenRouter key file through a local `.env` that is never committed. Then register the worker and the research concurrency limit once:

```sh
docker compose -f deploy/restate/compose.yaml up -d
RESTATE_ADMIN_URL=http://127.0.0.1:9070 ARTICLE_WORKER_URL=http://article-worker:9080 deploy/restate/register.sh
```

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
