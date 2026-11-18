#!/bin/sh
# Start or stop a disposable local single-node Elasticsearch for integration tests.
# Usage: scripts/es-test-server.sh start|stop
# On start it waits for readiness and prints STEELE_TEST_ES_URL. Security is
# disabled because the node binds only to 127.0.0.1 and holds synthetic data.
set -eu
NAME=steele-es-test
IMAGE=docker.elastic.co/elasticsearch/elasticsearch:8.19.2
case "${1:-start}" in
  start)
    docker run -d --rm --name "$NAME" -p 127.0.0.1::9200 \
      -e discovery.type=single-node -e xpack.security.enabled=false \
      -e ES_JAVA_OPTS="-Xms512m -Xmx512m" "$IMAGE" >/dev/null
    PORT=$(docker port "$NAME" 9200/tcp | head -1 | sed 's/.*://')
    i=0
    until curl -fs "http://127.0.0.1:$PORT" >/dev/null 2>&1; do
      i=$((i + 1)); [ "$i" -gt 120 ] && { echo "Elasticsearch did not start" >&2; exit 1; }
      sleep 1
    done
    echo "STEELE_TEST_ES_URL=http://127.0.0.1:$PORT"
    ;;
  stop)
    docker stop "$NAME" >/dev/null 2>&1 || true
    ;;
  *) echo "usage: $0 start|stop" >&2; exit 2 ;;
esac
