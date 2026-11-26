# n8n experiment track

The n8n half of the clean-slate n8n versus Mastra comparison. The contract is `doc/experiments/n8n-vs-mastra.md`; shared prompts, schemas and fixtures are in `experiments/shared/`.

## Layout

- `deploy/compose.yaml`: the separately named stack `steele-exp-n8n`. n8n is pinned by version and digest (2.49.7, multi-arch, runs on linux/arm64). Every host-specific value comes from the host's private `stack.env`.
- `deploy/deploy.sh`: copies only Git-tracked files to the host, starts or updates the stack, then imports every workflow in `workflows/` with n8n's own CLI.
- `workflows/`: workflow definitions, one JSON file each, with stable IDs, so a re-import updates a workflow rather than duplicating it. These files are the source of truth. Canvas edits that are not exported back to Git are lost on the next deploy.

## Storage and state

- Workflows, credentials, run history (inputs, outputs and errors of every execution, kept for 14 days) and users live in a dedicated PostgreSQL database and restricted role on the existing PostgreSQL service. That role cannot connect to any other database.
- n8n's local directory (`data/` on the host) holds its config and binary data.
- The encryption key and database password are files in the host's private `secrets/`, mounted read-only and passed with n8n's `_FILE` variables. They are never baked into an image or copied into workflow JSON.

## Access

- Bound to the private network only. Nothing is exposed on the LAN or the internet.
- n8n has no supported way to switch off its login: the variable that did this was removed in n8n 1.0. The instance owner is therefore provisioned from the environment (`N8N_INSTANCE_OWNER_*`, a bcrypt hash only), and the owner signs in once per browser. See #930.

## Operations

Deploy or update from a checkout:

```sh
STEELE_EXP_HOST=<host> STEELE_EXP_DIR=<stack dir> experiments/n8n/deploy/deploy.sh
```

- **Start or stop:** on the host, run `docker compose --env-file stack.env -f src/n8n/deploy/compose.yaml start` (or `stop`).
- **Update n8n:** change the pinned tag and digest in `compose.yaml` in a reviewed PR, then deploy. Back up the database first, because n8n migrates its schema on startup.
- **Rollback:**
  1. Revert the pin and redeploy.
  2. If a schema migration ran, also restore the database backup.
- **Workflow from the command line:** run these on the host, inside the container: `docker compose ... exec -T -e N8N_RUNNERS_BROKER_PORT=5690 n8n n8n <command> </dev/null`.
  - Commands: `execute --id <id>`, `export:workflow --id <id>`, `list:workflow`.
  - The CLI starts a second n8n process, so it needs its own task-broker port. Without `</dev/null`, `exec` swallows the rest of a piped script.
- **Inspection:** n8n's public API (`/api/v1/workflows`, `/api/v1/executions?includeData=true`) with a read-only scoped API key. The key is kept in the host's private secrets. Execution records show each node's inputs, outputs and errors.

## Setup evidence (#913, 2026-11-26)

- `SteeleExpSmoke01` was created from Git, executed, changed in Git (`revision: 2`), redeployed and executed again. Its output was read back through the API.
- `SteeleExpError01` fails on purpose. Its execution is recorded as `error`, with the node's message, and the CLI exits with 1.
- Run history survived a container restart.
- The interface answers only on the private-network address; the LAN address does not answer.
- About 410 MB RSS when idle.
- Note: n8n 2.49 warns that PostgreSQL 16 gets compatibility support only and recommends 17 or newer.

Actual hosts, addresses and credentials are recorded in the private operations project, not here.
