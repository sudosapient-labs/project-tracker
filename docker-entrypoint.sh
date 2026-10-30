#!/bin/sh
# Hosts such as Railway mount volumes owned by root. Started as root, hand the data directories to
# `node` and drop to it; started as any other user (e.g. `docker run --user`), run as-is.
set -e
if [ "$(id -u)" = "0" ]; then
  for d in "$(dirname "${DATABASE_PATH:-/data/sudo-sapient.db}")" "${UPLOAD_DIR:-/data/uploads}" ${BACKUP_DIR:+"$BACKUP_DIR"}; do
    mkdir -p "$d"
    # Anything left root-owned (a restored database, a backup run over `railway ssh`) would stop the
    # app from writing, so fix every entry, not just the directory.
    find "$d" ! -user node -exec chown node:node {} +
  done
  exec setpriv --reuid=node --regid=node --init-groups -- "$@"
fi
exec "$@"
