# Dashboard auto-update

The console (dashboard) updates itself after a successful application image build on `main` (#476). Every other container is left alone: the article worker, Restate and the publishers are never recreated by this path.

## How it works

`node dist/cli/update-dashboard.js` makes one bounded pass. A private scheduler on the deployment host runs it every few minutes, so no webhook or management endpoint is exposed. Portainer Community Edition has no stack webhooks; this uses its ordinary stack API.

1. Read the newest completed run of the "Publish application image" workflow on `main`. Anything other than a successful `push` to `main` is ignored.
2. Skip if that commit is already deployed, previously failed readiness, or is not strictly newer than the recorded deployment (GitHub compare status `ahead`). Older, duplicate and out-of-order builds therefore never redeploy, and nothing is ever downgraded.
3. Skip if the dashboard's live image differs from the recorded one. Someone changed it by hand, so the automation stops until an operator adopts the new state.
4. Resolve the commit-tagged image to its immutable digest, pull it onto the host, and replace only the dashboard image variable. The stack file and every other variable are read fresh and written back unchanged, with `pullImage: false` and `prune: false`.
5. Wait, with a bound, for `/health`, `/articles` and `/drafts` to answer 200. On failure, restore the previous image once, check again, and record the failed commit so it is not retried.

Each pass prints one JSON line: `deployed`, `skipped` with a reason, `rolled-back`, `rollback-failed` or `failed`. Exit status is non-zero for a rollback or failure, so the scheduler's log shows it.

## Operating it

- **Baseline:** before the first pass, record which commit the current dashboard image was built from: `update-dashboard --adopt <commit>`. Do the same after any manual dashboard change, which otherwise leaves the automation in `drift`.
- **Retry a failed commit:** fix forward with a newer build, or adopt a known-good state.
- **Stop it:** remove the scheduler entry. Nothing else depends on it.
- **Configuration:** the environment variables are listed at the top of `src/cli/update-dashboard.ts`. The real addresses, stack identity, key files and schedule belong to the private operations project only.

## Migrating a stack to the dedicated image variable

The checked-in stack gives the dashboard its own `STEELE_DASHBOARD_IMAGE`, falling back to the shared `STEELE_IMAGE`, so changing it touches nothing else. An existing stack needs that variable added once, set to the image the dashboard already runs, pinned by digest. Then run `--adopt <commit>` for that image's commit. Until then, `--adopt` refuses, because the variable is missing.

## Uncertain writes

Before the stack is touched, the pass saves a `pending` marker. If Portainer's response is lost, or the pass is interrupted, the next pass reads the live image first.
- If the new image is live, readiness and rollback run as normal.
- If the old image is still live, the marker is cleared (`not-applied`).
- Anything else is reported as drift for an operator.
