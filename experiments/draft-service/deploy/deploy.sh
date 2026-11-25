#!/usr/bin/env bash
# Build and (re)deploy the shared draft service (#912) on the experiment host.
# Private values come from the caller's environment, never from this repository:
#   STEELE_EXP_HOST  ssh destination of the experiment host
#   STEELE_EXP_DIR   stack directory on that host (holds src/, data/, secrets/, stack.env)
# The host's stack.env (private, mode 600) holds the bind address and directories;
# this script only rewrites its image tag line.
set -euo pipefail
: "${STEELE_EXP_HOST:?set STEELE_EXP_HOST}" "${STEELE_EXP_DIR:?set STEELE_EXP_DIR}"
here="$(cd "$(dirname "$0")/.." && pwd)"
tag="$(git -C "$here" rev-parse --short=12 HEAD)$(git -C "$here" diff --quiet HEAD -- . || echo -dirty)-$(date -u +%Y%m%d%H%M%S)"
# Transfer only files tracked by Git, so local configuration, tokens or .env
# files in the working tree can never reach the host or the image.
git -C "$here" ls-files -z -- . | rsync -a --delete --from0 --files-from=- "$here/" "$STEELE_EXP_HOST:$STEELE_EXP_DIR/src/"
ssh -o BatchMode=yes "$STEELE_EXP_HOST" bash -s -- "$STEELE_EXP_DIR" "$tag" <<'REMOTE'
set -euo pipefail
dir="$1"; tag="$2"; cd "$dir"
docker build -q -t "steele-exp-draft:$tag" src >/dev/null
previous="$(grep '^STEELE_EXP_DRAFT_TAG=' stack.env | cut -d= -f2)"
sed -i "s/^STEELE_EXP_DRAFT_TAG=.*/STEELE_EXP_DRAFT_TAG=$tag/" stack.env
docker compose --env-file stack.env -f src/deploy/compose.yaml up -d --wait >/dev/null
echo "deployed steele-exp-draft:$tag (previous: $previous)"
REMOTE
