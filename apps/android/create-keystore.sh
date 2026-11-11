#!/usr/bin/env bash
# Creates the key that signs the Android app, once:
#
#   apps/android/create-keystore.sh --keystore <path> --pass-file <file> [--alias sudo-sapient]
#
# The password is read from <file> (its first line; create it beforehand, readable only by you) and
# never appears on a command line. The keystore must be outside this repository and must not exist
# yet. Back up both files: without them the app can never be updated. See README.md.
set -euo pipefail

usage() {
  sed -n '2,8p' "$0" | sed 's/^# \{0,1\}//' >&2
  exit 2
}
die() {
  echo "create-keystore: $*" >&2
  exit 1
}

keystore= pass_file= alias=sudo-sapient
while [ $# -gt 0 ]; do
  case "$1" in
    --keystore) keystore=${2-} && shift 2 ;;
    --pass-file) pass_file=${2-} && shift 2 ;;
    --alias) alias=${2-} && shift 2 ;;
    -h | --help) usage ;;
    *) die "unknown option $1 (see --help)" ;;
  esac
done
[ -n "$keystore" ] && [ -n "$pass_file" ] && [ -n "$alias" ] || usage

[ -n "${JAVA_HOME-}" ] && [ -x "$JAVA_HOME/bin/keytool" ] || die "set JAVA_HOME to a JDK (17 or later)"
[ ! -e "$keystore" ] || die "$keystore already exists; refusing to replace a signing key"
[ -f "$pass_file" ] && [ -r "$pass_file" ] || die "password file $pass_file is missing or unreadable"
pass_len=$(head -n 1 "$pass_file" | tr -d '\r\n' | wc -c)
[ "$pass_len" -ge 6 ] || die "the password in $pass_file is shorter than 6 characters (keytool's minimum)"
[ "$pass_len" -ge 16 ] || echo "create-keystore: warning: a password under 16 characters is weak for a key that can't be replaced" >&2

# Where a directory resolves to, even if it doesn't exist yet: its nearest existing parent, resolved,
# plus the rest. So a path inside the repository is refused before anything is created.
resolve_dir() {
  d=$1 rest=
  while [ ! -d "$d" ]; do rest=/$(basename "$d")$rest d=$(dirname "$d"); done
  printf '%s%s\n' "$(cd "$d" && pwd -P)" "$rest"
}
repo=$(cd "$(dirname "$0")/../.." && pwd -P)
ks_dir=$(resolve_dir "$(dirname "$keystore")")
pf_dir=$(resolve_dir "$(dirname "$pass_file")")
for d in "$ks_dir" "$pf_dir"; do
  case "$d/" in "$repo"/*) die "$d is inside the repository; keep the key and its password outside it" ;; esac
done
if [ -n "$(find "$pass_file" -perm /077 2>/dev/null)" ]; then
  echo "create-keystore: warning: $pass_file can be read by other users; chmod 600 it" >&2
fi

# Before mkdir, so a new key directory is private (700) as well as the keystore (600).
umask 077
mkdir -p "$ks_dir"
keystore="$ks_dir/$(basename "$keystore")"
# PKCS12 (keytool's default) has one password for the store and the key.
# keytool reads the password from the file, so its output holds no secret: show it when it fails.
if ! kt_out=$("$JAVA_HOME/bin/keytool" -genkeypair -keystore "$keystore" -storetype PKCS12 -alias "$alias" \
  -keyalg RSA -keysize 4096 -validity 10000 -dname "CN=Sudo Sapient, O=Sudo Sapient" \
  -storepass:file "$pass_file" -keypass:file "$pass_file" 2>&1); then
  printf '%s\n' "$kt_out" >&2
  die "keytool failed"
fi

fingerprint=$("$JAVA_HOME/bin/keytool" -list -v -keystore "$keystore" -alias "$alias" -storepass:file "$pass_file" |
  sed -n 's/^[[:space:]]*SHA256: //p')
cat <<EOF
Created $keystore (alias $alias, RSA 4096, valid 10000 days).
SHA-256 certificate fingerprint: $fingerprint

Back up the keystore and the password now, somewhere other than this machine. If they're lost the
app can't be updated, and anyone who has both can ship updates as us.
EOF
