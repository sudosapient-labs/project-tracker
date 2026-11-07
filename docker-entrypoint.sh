#!/bin/sh
# Hosts such as Railway mount volumes owned by root. Started as root, hand the data directories to
# `node` and drop to it; started as any other user (e.g. `docker run --user`), run as-is.
set -e

# Only directories under /data, or BACKUP_DIR itself, are handed to `node`, so a mistyped setting
# (UPLOAD_DIR=/, a symlink to /etc) can't give it the system. Paths are resolved, symlinks included,
# before they are checked, and chown never follows a link.
refuse() {
  echo "[entrypoint] $1" >&2
  exit 1
}
under() {
  case "$1" in
    "$2" | "$2"/*) return 0 ;;
  esac
  return 1
}

if [ "$(id -u)" = "0" ]; then
  backup=""
  if [ -n "${BACKUP_DIR:-}" ]; then
    backup=$(realpath -m -- "$BACKUP_DIR")
    for sys in /bin /boot /dev /etc /lib /lib64 /proc /root /run /sbin /sys /usr /app; do
      if [ "$backup" = "/" ] || under "$backup" "$sys"; then refuse "BACKUP_DIR=$BACKUP_DIR ($backup) is a system directory; use a volume such as /backups."; fi
    done
  fi
  dirs="$(dirname "${DATABASE_PATH:-/data/sudo-sapient.db}")
${UPLOAD_DIR:-/data/uploads}${BACKUP_DIR:+
$BACKUP_DIR}"
  # Every directory is checked before any is touched.
  echo "$dirs" | while IFS= read -r d; do
    real=$(realpath -m -- "$d")
    if ! under "$real" /data && ! { [ -n "$backup" ] && under "$real" "$backup"; }; then
      refuse "Not taking ownership of $d ($real): DATABASE_PATH and UPLOAD_DIR must be under /data or BACKUP_DIR."
    fi
  done || exit 1
  echo "$dirs" | while IFS= read -r d; do
    real=$(realpath -m -- "$d")
    mkdir -p "$real"
    # Anything left root-owned (a restored database, a backup run over `railway ssh`) would stop the
    # app from writing, so fix every entry, not just the directory. find doesn't follow symlinks, and
    # -h changes a link itself, never what it points to.
    find "$real" ! -user node -exec chown -h node:node {} +
  done || exit 1
  exec setpriv --reuid=node --regid=node --init-groups -- "$@"
fi
exec "$@"
