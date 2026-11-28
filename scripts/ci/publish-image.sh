#!/usr/bin/env bash
# Publish one locally built image under its commit and version tags (#959).
# Usage: publish-image.sh <local-image> <repository> <version> <sha>
# Prints the published digest on stdout (the last line).
#
# A published tag is never moved. If the version or commit tag already exists,
# it must be an image of this same commit (its revision label). An existing
# version tag is reused as is; an existing commit tag (an interrupted earlier
# run) gets the version tag added server-side to that same image. Nothing is
# pushed in either case, which is how a rerun recovers after a partial publish.
# A tag that names another commit stops the job.
# Only an explicit "not found" counts as absent; any other inspection failure
# stops the job rather than risk moving a tag.
set -euo pipefail
local_image="$1"; repo="$2"; version="$3"; sha="$4"
versioned="${repo}:${version}"
committed="${repo}:sha-${sha}"

revision_of() { # prints the image's revision label, "absent", or fails
  local out
  if out="$(docker buildx imagetools inspect "$1" --format '{{json .Image.Config.Labels}}' 2> inspect.err)"; then
    printf '%s' "$out" | jq -r '."org.opencontainers.image.revision" // "unlabelled"'
  elif grep -qiE 'not found|manifest unknown' inspect.err; then
    echo absent
  else
    echo "::error::could not inspect ${1}" >&2
    return 1
  fi
}
digest_of() { docker buildx imagetools inspect "$1" --format '{{json .Manifest.Digest}}' | tr -d '"'; }

for ref in "$versioned" "$committed"; do
  rev="$(revision_of "$ref")"
  if [ "$rev" != absent ] && [ "$rev" != "$sha" ]; then
    echo "::error::${ref} already names another commit; tags are never moved" >&2
    exit 1
  fi
done
if [ "$(revision_of "$versioned")" = "$sha" ]; then
  echo "${versioned} already published for this commit; nothing pushed." >&2
  digest_of "$versioned"
  exit 0
fi
# The commit tag was published by an earlier, interrupted run: never push a
# rebuild over it (a rebuild can differ). Point the version tag at the very
# same published image, server-side, and push nothing. --prefer-index=false
# keeps the original manifest (and so its digest) rather than wrapping it in a
# new index.
if [ "$(revision_of "$committed")" = "$sha" ]; then
  docker buildx imagetools create --prefer-index=false --tag "$versioned" "$committed" >&2
  d="$(digest_of "$versioned")"
  test "$d" = "$(digest_of "$committed")"
  echo "${committed} already published; tagged it ${versioned} without pushing." >&2
  echo "$d"
  exit 0
fi
docker tag "$local_image" "$committed"
docker tag "$local_image" "$versioned"
docker push --quiet "$committed" >&2
docker push --quiet "$versioned" >&2
d="$(digest_of "$versioned")"
test "$d" = "$(digest_of "$committed")"
echo "$d"
