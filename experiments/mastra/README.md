# Mastra experiment track

This is the Mastra side of the [n8n versus Mastra experiment](../../doc/experiments/n8n-vs-mastra.md) (#911). It's a native Mastra project: workflows are TypeScript in `src/mastra/workflows/`, built with `mastra build --studio`, and served by the Mastra server together with Studio.

- **Versions:** Mastra 1.82.0, CLI 1.38.0 and Node 22.23.4. They are pinned in `package.json`, with `overrides` so that the CLI's deployer and server match the pinned core.
- **State:** LibSQL (`STEELE_EXP_MASTRA_DB`) holds workflow snapshots, run history and traces. Traces come from `MastraStorageExporter`, so Studio and the API can query them.
- **Access:** Mastra `SimpleAuth` protects every `/api/*` route and Studio. The token is read from a mounted file (`STEELE_EXP_MASTRA_TOKEN_FILE`); there is no default. In Studio, enter any email and use the token as the password. `/health` is open.
- **Local development:**
  ```bash
  npm ci
  STEELE_EXP_MASTRA_INSECURE_DEV=1 npm run dev
  ```
  This runs with no authentication and is for local development only.
- **Deploy:** run `deploy/deploy.sh`, setting `STEELE_EXP_HOST` and `STEELE_EXP_DIR` from private configuration. It builds the image on the linux/arm64 host and updates the compose stack defined in `deploy/compose.yaml`. That compose file contains only placeholders: the real bind address, directories and token live in private configuration outside this repository.

## Inspecting runs

| What | How |
|---|---|
| Workflows and their schemas | Studio, Workflows view; or `GET /api/workflows` |
| Start a run | Studio; or `POST /api/workflows/<id>/create-run`, then `POST /api/workflows/<id>/start-async?runId=…` with `{"inputData":…}` |
| Run history, step inputs and outputs, errors | Studio; or `GET /api/workflows/<id>/runs` |
| Traces and durations | Studio, Observability view; or `GET /api/observability/traces` |
