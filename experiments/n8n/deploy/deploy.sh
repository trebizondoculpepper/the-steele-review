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
"${compose[@]}" exec -T n8n sh -c 'grep -q " /run/import tmpfs " /proc/mounts' </dev/null || { echo "no tmpfs at /run/import; refusing to import credentials" >&2; exit 1; }
cli=("${compose[@]}" exec -T -e N8N_RUNNERS_BROKER_PORT=5690 n8n n8n)
# Apply the experiment's own schema (idempotent SQL) to its dedicated database.
set -a; . ./stack.env; set +a
for f in src/n8n/sql/*.sql; do
  docker run --rm -i -e PGOPTIONS=-cclient_min_messages=warning -e PGPASSWORD="$(cat secrets/postgres.password)" postgres:16-alpine \
    psql -q -v ON_ERROR_STOP=1 -h "$STEELE_EXP_N8N_DB_HOST" -p "${STEELE_EXP_N8N_DB_PORT:-5432}" \
    -U "$STEELE_EXP_N8N_DB_USER" -d "$STEELE_EXP_N8N_DB_NAME" <"$f" >/dev/null
done
psqlx() { docker run --rm -i -e PGOPTIONS=-cclient_min_messages=warning -e PGPASSWORD="$(cat secrets/postgres.password)" postgres:16-alpine \
  psql -qtA -v ON_ERROR_STOP=1 -h "$STEELE_EXP_N8N_DB_HOST" -p "${STEELE_EXP_N8N_DB_PORT:-5432}" -U "$STEELE_EXP_N8N_DB_USER" -d "$STEELE_EXP_N8N_DB_NAME" "$@"; }
# Shared prompts (#916) are loaded exactly as committed in experiments/shared/prompts/, keyed by
# <id>@sha256:<hash of the file bytes>. The table is append-only, so attempts keep their pinned prompt.
# The database recomputes the hash of what it received and refuses a mismatch.
for f in src/shared/prompts/*.md; do
  name="$(sed -n 's/^id:[[:space:]]*\([^[:space:]]*\).*/\1/p' "$f" | head -1)"
  sha="$(sha256sum "$f" | cut -d' ' -f1)"
  [ -n "$name" ] || { echo "prompt $f has no id" >&2; exit 1; }
  b64="$(base64 -w0 "$f")"
  psqlx -v name="$name" -v sha="$sha" -v b64="$b64" >/dev/null <<'SQL'
INSERT INTO steele_wr.prompts (identity, name, sha256, content)
SELECT :'name' || '@sha256:' || :'sha', :'name', :'sha', convert_from(decode(:'b64', 'base64'), 'UTF8')
WHERE encode(sha256(decode(:'b64', 'base64')), 'hex') = :'sha'
ON CONFLICT (identity) DO NOTHING;
SELECT 1 / (SELECT count(*) FROM steele_wr.prompts WHERE identity = :'name' || '@sha256:' || :'sha')::integer;
SQL
done
# The live switch and limits (off unless the private stack.env enables them).
psqlx -v live="${STEELE_EXP_N8N_LIVE_MODEL_ENABLED:-0}" -v calls="${STEELE_EXP_N8N_MAX_LIVE_CALLS:-1}" -v budget="${STEELE_EXP_N8N_LIVE_BUDGET_USD:-0.05}" >/dev/null <<'SQL'
INSERT INTO steele_wr.settings VALUES ('live_enabled', :'live'), ('max_live_calls', :'calls'), ('live_budget_usd', :'budget'),
  ('estimated_live_call_usd', '0.01')
ON CONFLICT (key) DO UPDATE SET value = excluded.value;
SQL
# The workflows' Postgres credential is built here from the private secrets and streamed into n8n's
# importer, which encrypts it. The plaintext only ever exists in a memory-backed tmpfs inside the
# container (compose.yaml), and is removed on exit, interruption or failure.
python3 - <<'PY' | "${compose[@]}" exec -T -e N8N_RUNNERS_BROKER_PORT=5690 n8n sh -c 'set -u; f=/run/import/cred.json; trap "rm -f $f /run/import/cred.log" EXIT INT TERM HUP; umask 077; cat >"$f"; n8n import:credentials --input="$f" >/run/import/cred.log 2>&1 || { tail -5 /run/import/cred.log >&2; exit 1; }'
import json, os, re
def live_key():
    # TOML: ignore comments; exactly one active OPENROUTER_API_KEY assignment is accepted.
    text = open(os.environ["STEELE_EXP_N8N_MODEL_KEY_FILE"]).read()
    pattern = re.compile(r"^\s*OPENROUTER_API_KEY\s*=\s*([\"'])([^\"']+)\1\s*(#.*)?$")
    keys = [m.group(2) for l in text.split("\n") if not l.lstrip().startswith("#") for m in [pattern.match(l)] if m]
    if len(keys) != 1 or not re.fullmatch(r"[A-Za-z0-9._-]{20,200}", keys[0]):
        raise SystemExit("model key unavailable")
    return keys[0]
print(json.dumps([{"id": "SteeleExpPgFeed01", "name": "steele-exp feed postgres", "type": "postgres",
  "data": {"host": os.environ["STEELE_EXP_N8N_DB_HOST"], "port": int(os.environ.get("STEELE_EXP_N8N_DB_PORT", "5432")),
           "database": os.environ["STEELE_EXP_N8N_DB_NAME"], "user": os.environ["STEELE_EXP_N8N_DB_USER"],
           "password": open("secrets/postgres.password").read().strip(), "ssl": "disable"}},
  # OpenRouter (#916): the key is read from the canonical model-provider file only while live calls are
  # enabled; otherwise the credential holds a placeholder, so no usable key stays in n8n's store.
  {"id": "SteeleExpOpenRtr01", "name": "steele-exp openrouter", "type": "httpHeaderAuth",
   "data": {"name": "Authorization", "value": "Bearer " + (live_key() if os.environ.get("STEELE_EXP_N8N_LIVE_MODEL_ENABLED") == "1" else "live-calls-disabled")}}]))
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
