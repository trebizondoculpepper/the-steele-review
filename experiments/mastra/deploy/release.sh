#!/usr/bin/env bash
# Deploy a published, reviewed Mastra release (#969) to the experiment host,
# pinned by image digest. Nothing is built on the host and no paid model call
# is made: the script pulls the ARM64 image, records its digest, swaps the
# image reference in the private stack.env, restarts the stack, and checks
# health and native workflow registration. Persistent data, configuration
# mounts and the collections repository (with its indexing hook) are mounts
# and are untouched.
#
#   STEELE_EXP_HOST  ssh destination of the experiment host
#   STEELE_EXP_DIR   stack directory on that host
#   usage: release.sh <version>      e.g. release.sh 0.6.0
#
# Rollback: the previous image reference is printed (and kept in stack.env as
# STEELE_EXP_MASTRA_IMAGE_PREVIOUS); `release.sh --rollback` restores it.
set -euo pipefail
: "${STEELE_EXP_HOST:?set STEELE_EXP_HOST}" "${STEELE_EXP_DIR:?set STEELE_EXP_DIR}"
version="${1:?usage: release.sh <version> | --rollback}"
here="$(cd "$(dirname "$0")/.." && pwd)"
# Only the compose file changes on the host; it comes from Git, not the working tree.
git -C "$here" diff --quiet HEAD -- deploy/compose.yaml || { echo "deploy/compose.yaml has uncommitted changes" >&2; exit 1; }
git -C "$here" show HEAD:experiments/mastra/deploy/compose.yaml | ssh -o BatchMode=yes "$STEELE_EXP_HOST" "cat > '$STEELE_EXP_DIR/src/mastra/deploy/compose.yaml'"
ssh -o BatchMode=yes "$STEELE_EXP_HOST" bash -s -- "$STEELE_EXP_DIR" "$version" <<'REMOTE'
set -euo pipefail
dir="$1"; version="$2"; cd "$dir"
repo="ghcr.io/trebizondoculpepper/the-steele-review/mastra"
current="$(grep '^STEELE_EXP_MASTRA_IMAGE=' stack.env | cut -d= -f2 || true)"
if [ -z "$current" ]; then
  # Stacks deployed before #969 recorded only a local build tag.
  tag="$(grep '^STEELE_EXP_MASTRA_TAG=' stack.env | cut -d= -f2 || true)"
  [ -n "$tag" ] && current="steele-exp-mastra:$tag"
fi
if [ "$version" = "--rollback" ]; then
  target="$(grep '^STEELE_EXP_MASTRA_IMAGE_PREVIOUS=' stack.env | cut -d= -f2)"
  [ -n "$target" ] || { echo "no previous image recorded" >&2; exit 1; }
else
  docker pull -q --platform linux/arm64 "$repo:$version" >/dev/null
  target="$(docker image inspect "$repo:$version" --format '{{index .RepoDigests 0}}')"
fi
set_env() { grep -q "^$1=" stack.env || echo "$1=" >> stack.env; sed -i "s|^$1=.*|$1=$2|" stack.env; }
# Keep the last working reference: a retry after a failed or interrupted
# attempt (or a redeploy of the same release) finds the target already
# configured and must not overwrite the rollback reference with it.
if [ "$target" != "$current" ]; then
  set_env STEELE_EXP_MASTRA_IMAGE_PREVIOUS "$current"
  set_env STEELE_EXP_MASTRA_IMAGE "$target"
fi
current="$(grep '^STEELE_EXP_MASTRA_IMAGE_PREVIOUS=' stack.env | cut -d= -f2 || true)"
docker compose --env-file stack.env -f src/mastra/deploy/compose.yaml up -d --wait >/dev/null
container="$(docker compose --env-file stack.env -f src/mastra/deploy/compose.yaml ps -q mastra)"
health="$(docker inspect "$container" --format '{{.State.Health.Status}}')"
revision="$(docker inspect "$container" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}')"
workflows="$(docker exec "$container" node -e 'fetch("http://127.0.0.1:4111/api/workflows").then(r=>r.json()).then(w=>console.log(Object.keys(w).sort().join(",")))')"
echo "deployed: $target"
echo "revision: $revision"
echo "health:   $health"
echo "workflows: $workflows"
echo "rollback: $current"
REMOTE
