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
"${compose[@]}" exec -T n8n n8n import:workflow --separate --input=/workflows 2>&1 | grep -v '^$' | tail -3
echo "deployed steele-exp-n8n workflows from $rev"
REMOTE
