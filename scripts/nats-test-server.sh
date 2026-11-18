#!/bin/sh
# Start or stop a disposable local JetStream server for integration tests.
# Usage: scripts/nats-test-server.sh start|stop
# On start it prints the STEELE_TEST_NATS_URL to export. No private config.
set -eu
NAME=steele-nats-test
case "${1:-start}" in
  start)
    docker run -d --rm --name "$NAME" -p 127.0.0.1::4222 nats:2 -js >/dev/null
    PORT=$(docker port "$NAME" 4222/tcp | head -1 | sed 's/.*://')
    echo "STEELE_TEST_NATS_URL=nats://127.0.0.1:$PORT"
    ;;
  stop)
    docker stop "$NAME" >/dev/null 2>&1 || true
    ;;
  *) echo "usage: $0 start|stop" >&2; exit 2 ;;
esac
