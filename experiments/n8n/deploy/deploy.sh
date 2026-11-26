#!/usr/bin/env bash
# Deploy the n8n experiment stack (#913) and import its Git-tracked workflows.
# Private values come from the caller's environment, never from this repository:
#   STEELE_EXP_HOST  ssh destination of the experiment host
#   STEELE_EXP_DIR   stack directory on that host (holds src/, data/, secrets/, stack.env)
# The image is pinned in compose.yaml, so updating n8n is a reviewed change to that pin.
set -euo pipefail
: "${STEELE_EXP_HOST:?set STEELE_EXP_HOST}" "${STEELE_EXP_DIR:?set STEELE_EXP_DIR}"
here="$(cd "$(dirname "$0")/.." && pwd)"
experiments="$(cd "$here/.." && pwd)"
rev="$(git -C "$here" rev-parse --short=12 HEAD)$(git -C "$experiments" diff --quiet HEAD -- n8n shared || echo -dirty)"
# Transfer only files tracked by Git into a fresh staging directory, then swap it in.
ssh -o BatchMode=yes "$STEELE_EXP_HOST" "rm -rf '$STEELE_EXP_DIR/src.next' && mkdir -p '$STEELE_EXP_DIR/src.next'"
git -C "$experiments" ls-files -z -- n8n shared | rsync -a --from0 --files-from=- "$experiments/" "$STEELE_EXP_HOST:$STEELE_EXP_DIR/src.next/"
ssh -o BatchMode=yes "$STEELE_EXP_HOST" "cd '$STEELE_EXP_DIR' && rm -rf src.previous && { [ ! -d src ] || mv src src.previous; } && mv src.next src"
ssh -o BatchMode=yes "$STEELE_EXP_HOST" bash -s -- "$STEELE_EXP_DIR" "$rev" <<'REMOTE'
set -euo pipefail
dir="$1"; rev="$2"; cd "$dir"
compose=(docker compose --env-file stack.env -f src/n8n/deploy/compose.yaml)
"${compose[@]}" up -d --wait >/dev/null
cli=("${compose[@]}" exec -T -e N8N_RUNNERS_BROKER_PORT=5690 n8n n8n)
# Apply the experiment's own schema (idempotent SQL) to its dedicated database.
set -a; . ./stack.env; set +a
for f in src/n8n/sql/*.sql; do
  docker run --rm -i -e PGPASSWORD="$(cat secrets/postgres.password)" postgres:16-alpine \
    psql -q -v ON_ERROR_STOP=1 -h "$STEELE_EXP_N8N_DB_HOST" -p "${STEELE_EXP_N8N_DB_PORT:-5432}" \
    -U "$STEELE_EXP_N8N_DB_USER" -d "$STEELE_EXP_N8N_DB_NAME" <"$f" >/dev/null
done
# The workflows' Postgres credential is built here from the private secrets and streamed into n8n's
# importer, which encrypts it; it never exists in Git or as a file outside the container's tmpfs.
python3 - <<'PY' | "${compose[@]}" exec -T -e N8N_RUNNERS_BROKER_PORT=5690 n8n sh -c 'umask 077; cat >/tmp/cred.json; n8n import:credentials --input=/tmp/cred.json >/tmp/cred.log 2>&1; rc=$?; rm -f /tmp/cred.json; [ $rc = 0 ] || tail -5 /tmp/cred.log >&2; exit $rc'
import json, os
print(json.dumps([{"id": "SteeleExpPgFeed01", "name": "steele-exp feed postgres", "type": "postgres",
  "data": {"host": os.environ["STEELE_EXP_N8N_DB_HOST"], "port": int(os.environ.get("STEELE_EXP_N8N_DB_PORT", "5432")),
           "database": os.environ["STEELE_EXP_N8N_DB_NAME"], "user": os.environ["STEELE_EXP_N8N_DB_USER"],
           "password": open("secrets/postgres.password").read().strip(), "ssl": "disable"}}]))
PY
# Create or update every workflow from its Git definition (stable IDs make re-import an update).
# Copied in fresh on every deploy: a bind mount would keep pointing at the swapped-out src.
"${compose[@]}" exec -T n8n rm -rf /tmp/workflows </dev/null
"${compose[@]}" cp src/n8n/workflows n8n:/tmp/workflows >/dev/null
# The CLI starts its own n8n process, so it needs a task broker port distinct from the server's.
log="$(mktemp)"; trap 'rm -f "$log"' EXIT
if ! "${cli[@]}" import:workflow --separate --input=/tmp/workflows </dev/null >"$log" 2>&1; then
  grep -vE 'Warning|^\s*$' "$log" | tail -20 >&2
  echo "workflow import FAILED; the running instance may hold stale workflows" >&2
  exit 1
fi
grep -E 'Importing|imported' "$log" || true
# Publish the listed workflows (schedules and webhooks); n8n applies CLI changes on restart.
while read -r id; do
  [ -z "$id" ] || "${cli[@]}" publish:workflow --id="$id" </dev/null >"$log" 2>&1 || { tail -5 "$log" >&2; echo "publishing $id FAILED" >&2; exit 1; }
done < src/n8n/workflows/published.txt
"${compose[@]}" restart n8n >/dev/null 2>&1
"${compose[@]}" up -d --wait >/dev/null 2>&1
echo "deployed steele-exp-n8n workflows from $rev"
REMOTE
