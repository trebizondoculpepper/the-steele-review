#!/usr/bin/env bash
# Build and (re)deploy the Mastra experiment stack (#918) on the experiment host.
# Private values come from the caller's environment, never from this repository:
#   STEELE_EXP_HOST  ssh destination of the experiment host
#   STEELE_EXP_DIR   stack directory on that host (holds src/, data/, secrets/, stack.env)
# The host's stack.env (private, mode 600) holds the bind address and directories;
# this script only rewrites its image tag line.
set -euo pipefail
: "${STEELE_EXP_HOST:?set STEELE_EXP_HOST}" "${STEELE_EXP_DIR:?set STEELE_EXP_DIR}"
here="$(cd "$(dirname "$0")/.." && pwd)"
# The build context is experiments/: this track plus the shared contract files
# (prompts, schemas, fixtures), which the image loads from Git, not copies.
experiments="$(cd "$here/.." && pwd)"
tag="$(git -C "$here" rev-parse --short=12 HEAD)$(git -C "$experiments" diff --quiet HEAD -- mastra shared || echo -dirty)-$(date -u +%Y%m%d%H%M%S)"
# Transfer only files tracked by Git, so local configuration, tokens or .env
# files in the working tree can never reach the host or the image.
# Upload into a fresh staging directory and swap it in, so files deleted or
# renamed in Git never linger in the deployed source.
ssh -o BatchMode=yes "$STEELE_EXP_HOST" "rm -rf '$STEELE_EXP_DIR/src.next' && mkdir -p '$STEELE_EXP_DIR/src.next'"
git -C "$experiments" ls-files -z -- mastra shared | rsync -a --from0 --files-from=- "$experiments/" "$STEELE_EXP_HOST:$STEELE_EXP_DIR/src.next/"
ssh -o BatchMode=yes "$STEELE_EXP_HOST" "cd '$STEELE_EXP_DIR' && rm -rf src.previous && { [ ! -d src ] || mv src src.previous; } && mv src.next src"
ssh -o BatchMode=yes "$STEELE_EXP_HOST" bash -s -- "$STEELE_EXP_DIR" "$tag" <<'REMOTE'
set -euo pipefail
dir="$1"; tag="$2"; cd "$dir"
docker build -q -f src/mastra/Dockerfile -t "steele-exp-mastra:$tag" src >/dev/null
previous="$(grep '^STEELE_EXP_MASTRA_IMAGE=' stack.env | cut -d= -f2 || true)"
grep -q '^STEELE_EXP_MASTRA_IMAGE=' stack.env || echo "STEELE_EXP_MASTRA_IMAGE=" >> stack.env
sed -i "s|^STEELE_EXP_MASTRA_IMAGE=.*|STEELE_EXP_MASTRA_IMAGE=steele-exp-mastra:$tag|" stack.env
docker compose --env-file stack.env -f src/mastra/deploy/compose.yaml up -d --wait >/dev/null
echo "deployed steele-exp-mastra:$tag (previous: $previous)"
REMOTE
