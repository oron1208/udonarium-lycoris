#!/bin/bash
# Run on the VPS only, when explicitly instructed to roll back v2.2.
# Restores web assets/docs without restarting the container or touching room data.
set -euo pipefail
BACKUP=/root/release-backups/pre-v2.2-20261013
RESTORE="$BACKUP/restore-webroot"
CONTAINER="${LYCORIS_ROLLBACK_CONTAINER:-udonarium-lycoris}"
DOCS_ROOT="${LYCORIS_ROLLBACK_DOCS_ROOT:-/var/www/docs-site}"
test -s "$BACKUP/webroot-v2.0.tar.gz"
gzip -t "$BACKUP/webroot-v2.0.tar.gz"
mkdir -p "$RESTORE"
tar -xzf "$BACKUP/webroot-v2.0.tar.gz" -C "$RESTORE"
# Assets first; index is restored separately as the final application switch.
mv "$RESTORE/udonarium-lycoris/index.html" "$RESTORE/index-v2.0.html"
docker cp "$RESTORE/udonarium-lycoris/." "$CONTAINER":/app/dist/udonarium-lycoris/
docker cp "$BACKUP/index-v2.0.html" "$CONTAINER":/app/dist/udonarium-lycoris/index.html
cp "$BACKUP/docs/index.html" "$DOCS_ROOT/index.html"
cp "$BACKUP/docs/guide/self-host.html" "$DOCS_ROOT/guide/self-host.html"
if [ "${LYCORIS_ROLLBACK_UPDATE_LATEST:-1}" = 1 ]; then
  docker tag udonarium-lycoris:rollback-v2.0-20261013-pre-v2.2 udonarium-lycoris:latest
fi
docker cp "$BACKUP/manifest-v2.0.sha256" "$CONTAINER":/tmp/pre-v2.2-manifest.sha256
docker exec "$CONTAINER" sh -c 'cd /app/dist/udonarium-lycoris && sha256sum -c /tmp/pre-v2.2-manifest.sha256' > "$BACKUP/rollback-verification.log"
if [ "${LYCORIS_ROLLBACK_VERIFY_HTTP:-1}" = 1 ]; then
  curl -fsS http://127.0.0.1:12081/v1/status
fi
echo 'Restored v2.0 frontend and homepage. Connected users must reload their browsers.'
