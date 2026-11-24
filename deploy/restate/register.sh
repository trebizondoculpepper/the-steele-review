#!/bin/sh
# Register the article worker with Restate and set the shared research
# concurrency limit (#243). Idempotent; rerun after deploying a new worker.
# Fails unless Restate is healthy and the registration exposes ArticleRun and
# Research (#316). When DISCOVERY_WORKER_URL is set, also register the
# discoverer's DiscoveryPoll endpoint (#823) and require it to be exposed.
set -eu
ADMIN="${RESTATE_ADMIN_URL:-http://127.0.0.1:9070}"
WORKER="${ARTICLE_WORKER_URL:-http://article-worker:9080}"
# Diagnostics name the failing step only, never the configured endpoints.
curl -fs "$ADMIN/health" >/dev/null || { echo "restate admin not healthy" >&2; exit 1; }
curl -fs -X POST "$ADMIN/deployments" -H 'content-type: application/json' \
  -d "{\"uri\": \"$WORKER\", \"force\": true}" >/dev/null || { echo "worker registration failed" >&2; exit 1; }
curl -fs -X PUT "$ADMIN/limits/rules" -H 'content-type: application/json' \
  -d '[{"pattern": "research", "limits": {"concurrency": 2}, "description": "Active Sonar research jobs (#243)"}]' >/dev/null || { echo "research limit update failed" >&2; exit 1; }
expected="ArticleRun Research"
if [ -n "${DISCOVERY_WORKER_URL:-}" ]; then
  curl -fs -X POST "$ADMIN/deployments" -H 'content-type: application/json' \
    -d "{\"uri\": \"$DISCOVERY_WORKER_URL\", \"force\": true}" >/dev/null || { echo "discovery registration failed" >&2; exit 1; }
  expected="$expected DiscoveryPoll"
fi
services="$(curl -fs "$ADMIN/services")" || { echo "service listing failed" >&2; exit 1; }
for name in $expected; do
  echo "$services" | grep -Eq "\"name\": *\"$name\"" || { echo "registration does not expose $name" >&2; exit 1; }
done
echo "registered: $expected; research concurrency limited to 2"
