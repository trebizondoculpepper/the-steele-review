#!/bin/sh
# Keep browsable content checkouts fresh without overwriting local edits (#420).
#
#   refresh-checkouts.sh <status-dir> <name>=<checkout> [<name>=<checkout> ...]
#
# For each named working copy (a normal clone of an artifact repository, for
# example the archive and the processed content), fast-forward it to its
# origin's current branch head, and only when that is safe:
#
#   - the checkout has no tracked or untracked local changes;
#   - its HEAD is an ancestor of the remote head (nothing local would be lost).
#
# Otherwise it is left exactly as it is: never reset, cleaned, stashed or
# rebased. The view is then reported "stale" with a reason, so an operator can
# see why it stopped refreshing. Concurrent runs are serialised by an atomic
# lock directory; a run that finds the lock held exits without doing anything.
#
# One status file per view is written to <status-dir>/<name>.json:
#   {"view","state":"fresh"|"stale","reason"?,"revision","checkedAt","lastSuccessAt"?}
# It holds no paths, URLs or file names. Application workers never call this;
# artifact writes stay behind GitArtifactStore. Run it from a scheduler
# (configured privately) at a bounded interval.
set -eu

[ "$#" -ge 2 ] || { echo "usage: refresh-checkouts.sh <status-dir> <name>=<checkout>..." >&2; exit 2; }
status_dir=$1
shift
mkdir -p "$status_dir"

lock="$status_dir/.refresh.lock"
if ! mkdir "$lock" 2>/dev/null; then
  # A lock older than 10 minutes was left by a killed run: take it over.
  if [ -n "$(find "$lock" -maxdepth 0 -mmin +10 2>/dev/null)" ]; then
    rmdir "$lock" 2>/dev/null || true
    mkdir "$lock" 2>/dev/null || exit 0
  else
    exit 0
  fi
fi
trap 'rmdir "$lock" 2>/dev/null || true' EXIT INT TERM

now() { date -u +%Y-%m-%dT%H:%M:%SZ; }

write_status() { # name state reason revision
  file="$status_dir/$1.json"
  last=""
  if [ "$2" = fresh ]; then
    last=$(now)
  elif [ -f "$file" ]; then
    last=$(sed -n 's/.*"lastSuccessAt":"\([^"]*\)".*/\1/p' "$file")
  fi
  {
    printf '{"view":"%s","state":"%s"' "$1" "$2"
    [ -n "$3" ] && printf ',"reason":"%s"' "$3"
    printf ',"revision":"%s","checkedAt":"%s"' "$4" "$(now)"
    [ -n "$last" ] && printf ',"lastSuccessAt":"%s"' "$last"
    printf '}\n'
  } >"$file.tmp"
  mv "$file.tmp" "$file"
  if [ "$2" = stale ]; then
    printf '{"event":"content-view-refresh","view":"%s","state":"stale","reason":"%s"}\n' "$1" "$3" >&2
  fi
}

refresh() { # name checkout
  name=$1
  dir=$2
  case "$name" in *[!a-z0-9-]* | "") echo "invalid view name" >&2; return 2 ;; esac
  if ! head=$(git -C "$dir" rev-parse --verify -q HEAD); then
    write_status "$name" stale not-a-checkout ""
    return 0
  fi
  if [ -n "$(git -C "$dir" status --porcelain --untracked-files=all)" ]; then
    write_status "$name" stale local-changes "$head"
    return 0
  fi
  branch=$(git -C "$dir" symbolic-ref --quiet --short HEAD) || {
    write_status "$name" stale detached-head "$head"
    return 0
  }
  if ! git -C "$dir" fetch --quiet origin "$branch" 2>/dev/null; then
    write_status "$name" stale fetch-failed "$head"
    return 0
  fi
  remote=$(git -C "$dir" rev-parse --verify -q FETCH_HEAD)
  if [ "$head" = "$remote" ]; then
    write_status "$name" fresh "" "$head"
    return 0
  fi
  if ! git -C "$dir" merge-base --is-ancestor "$head" "$remote"; then
    write_status "$name" stale diverged "$head"
    return 0
  fi
  if git -C "$dir" merge --ff-only --quiet "$remote" 2>/dev/null; then
    write_status "$name" fresh "" "$remote"
  else
    write_status "$name" stale fast-forward-failed "$head"
  fi
}

for view in "$@"; do
  refresh "${view%%=*}" "${view#*=}"
done
