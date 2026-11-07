#!/bin/sh
# Hosts such as Railway mount volumes owned by root. Started as root, hand /data to `node` and drop
# to it; started as any other user, run as-is. Only /data is ever touched, and chown never follows
# a link.
set -e
if [ "$(id -u)" = "0" ]; then
  mkdir -p /data
  find /data ! -user node -exec chown -h node:node {} +
  exec setpriv --reuid=node --regid=node --init-groups -- "$@"
fi
exec "$@"
