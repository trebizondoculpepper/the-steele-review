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
# Create or update every workflow from its Git definition (stable IDs make re-import an update).
# Copied in fresh on every deploy: a bind mount would keep pointing at the swapped-out src.
"${compose[@]}" exec -T n8n rm -rf /tmp/workflows </dev/null
"${compose[@]}" cp src/n8n/workflows n8n:/tmp/workflows >/dev/null
# The CLI starts its own n8n process, so it needs a task broker port distinct from the server's.
"${compose[@]}" exec -T -e N8N_RUNNERS_BROKER_PORT=5690 n8n n8n import:workflow --separate --input=/tmp/workflows </dev/null 2>&1 | grep -E 'Importing|imported|rror' || true
echo "deployed steele-exp-n8n workflows from $rev"
REMOTE
