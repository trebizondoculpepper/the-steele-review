#!/bin/sh
# Register the article worker with Restate and set the shared research
# concurrency limit (#243). Idempotent; rerun after deploying a new worker.
set -eu
ADMIN="${RESTATE_ADMIN_URL:-http://127.0.0.1:9070}"
WORKER="${ARTICLE_WORKER_URL:-http://article-worker:9080}"
curl -fsS -X POST "$ADMIN/deployments" -H 'content-type: application/json' \
  -d "{\"uri\": \"$WORKER\", \"force\": true}" >/dev/null
curl -fsS -X PUT "$ADMIN/limits/rules" -H 'content-type: application/json' \
  -d '[{"pattern": "research", "limits": {"concurrency": 2}, "description": "Active Sonar research jobs (#243)"}]' >/dev/null
echo "worker registered; research concurrency limited to 2"
