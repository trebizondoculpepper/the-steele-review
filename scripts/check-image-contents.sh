#!/bin/sh
# Build the application image and verify its actual contents: no local
# configuration, credential files or repository metadata may be inside.
# Usage: scripts/check-image-contents.sh [tag]
set -eu
TAG="${1:-steele-review:image-check}"
docker build -q -t "$TAG" . >/dev/null
# Application and user locations only: system CA certificates are expected.
FOUND=$(docker run --rm --entrypoint sh "$TAG" -c \
  'find /app /home /root /tmp -xdev -path /app/node_modules -prune -o \
     \( -name ".env" -o -name ".env.*" -o -name "secret.md" -o -name "*.secret" -o -name "secrets" -o -name ".git" -o -name "pdb.toml" -o -name "*.pem" -o -name "*.key" \) -print 2>/dev/null' || true)
if [ -n "$FOUND" ]; then
  echo "image contains forbidden files:"; echo "$FOUND"; exit 1
fi
echo "image $TAG: no local configuration or credential files found"
docker run --rm --entrypoint sh "$TAG" -c 'ls /app'
