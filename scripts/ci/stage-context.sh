#!/usr/bin/env bash
# Stage an image build context from tracked files only (#959).
# Usage: stage-context.sh <image> <commit> <output-dir>
# The context is exported with `git archive` from the commit, so untracked,
# ignored or local files (configuration, tokens, .env files, node_modules) can
# never reach an image, whatever is in the working tree.
set -euo pipefail
image="$1"; commit="$2"; out="$3"
case "$image" in
  # Mastra builds from experiments/ with this track plus the shared contracts.
  mastra) paths=(experiments/mastra experiments/shared); strip=1 ;;
  # The draft service builds from its own directory.
  draft-service) paths=(experiments/draft-service); strip=2 ;;
  *) echo "unknown image: $image" >&2; exit 2 ;;
esac
rm -rf "$out"; mkdir -p "$out"
git archive --format=tar "$commit" -- "${paths[@]}" | tar -x -C "$out" --strip-components="$strip"
echo "staged $image from $(git rev-parse --short "$commit"): $(find "$out" -type f | wc -l | tr -d ' ') tracked files"
