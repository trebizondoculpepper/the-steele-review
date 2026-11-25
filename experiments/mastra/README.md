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
