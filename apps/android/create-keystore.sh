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

repo=$(cd "$(dirname "$0")/../.." && pwd -P)
ks_dir=$(mkdir -p "$(dirname "$keystore")" && cd "$(dirname "$keystore")" && pwd -P)
pf_dir=$(cd "$(dirname "$pass_file")" && pwd -P)
for d in "$ks_dir" "$pf_dir"; do
  case "$d/" in "$repo"/*) die "$d is inside the repository; keep the key and its password outside it" ;; esac
done
keystore="$ks_dir/$(basename "$keystore")"

umask 077
# PKCS12 (keytool's default) has one password for the store and the key.
"$JAVA_HOME/bin/keytool" -genkeypair -keystore "$keystore" -storetype PKCS12 -alias "$alias" \
  -keyalg RSA -keysize 4096 -validity 10000 -dname "CN=Sudo Sapient, O=Sudo Sapient" \
  -storepass:file "$pass_file" -keypass:file "$pass_file" >/dev/null 2>&1 ||
  die "keytool failed (run with a readable password file and a JDK in JAVA_HOME)"

fingerprint=$("$JAVA_HOME/bin/keytool" -list -v -keystore "$keystore" -alias "$alias" -storepass:file "$pass_file" |
  sed -n 's/^[[:space:]]*SHA256: //p')
cat <<EOF
Created $keystore (alias $alias, RSA 4096, valid 10000 days).
SHA-256 certificate fingerprint: $fingerprint

Back up the keystore and the password now, somewhere other than this machine. If they're lost the
app can't be updated, and anyone who has both can ship updates as us.
EOF
