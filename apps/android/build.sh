#!/usr/bin/env bash
# Builds a signed release APK of the Android app:
#
#   apps/android/build.sh                   production (the committed project, as it is)
#   apps/android/build.sh --staging         staging: dev.sudosapient.app.staging, "Sudo Sapient (staging)"
#   apps/android/build.sh --host <host>     another HTTPS host: dev.sudosapient.app.test, "Sudo Sapient (test)"
#                                           (--package-id and --name override those two)
#
# Signing, from the environment (or the matching --flags):
#   ANDROID_KEYSTORE            --keystore            the keystore, outside this repository
#   ANDROID_KEY_ALIAS           --alias               the key's alias (default sudo-sapient)
#   ANDROID_KEYSTORE_PASS_FILE  --keystore-pass-file  file whose first line is the keystore password
#   ANDROID_KEY_PASS_FILE       --key-pass-file       the key's password (default: the keystore's)
# Tools: JAVA_HOME (JDK 17) and ANDROID_HOME (an SDK with platform 36 and build-tools).
# Output: apps/android/out/ (git-ignored), or --out <dir>. See README.md.
set -euo pipefail

usage() {
  sed -n '2,16p' "$0" | sed 's/^# \{0,1\}//' >&2
  exit 2
}
die() {
  echo "build: $*" >&2
  exit 1
}

here=$(cd "$(dirname "$0")" && pwd -P)
repo=$(cd "$here/../.." && pwd -P)
production_host=$(sed -n 's/^ *"host": "\([^"]*\)".*/\1/p' "$here/twa-manifest.json")
staging_host=sudo-tracker-staging.up.railway.app

keystore=${ANDROID_KEYSTORE-} alias=${ANDROID_KEY_ALIAS:-sudo-sapient}
store_pass_file=${ANDROID_KEYSTORE_PASS_FILE-} key_pass_file=${ANDROID_KEY_PASS_FILE-}
host= package_id= name= out="$here/out"
while [ $# -gt 0 ]; do
  case "$1" in
    --staging) host=$staging_host && shift ;;
    --host) host=${2-} && shift 2 ;;
    --package-id) package_id=${2-} && shift 2 ;;
    --name) name=${2-} && shift 2 ;;
    --keystore) keystore=${2-} && shift 2 ;;
    --alias) alias=${2-} && shift 2 ;;
    --keystore-pass-file) store_pass_file=${2-} && shift 2 ;;
    --key-pass-file) key_pass_file=${2-} && shift 2 ;;
    --out) out=${2-} && shift 2 ;;
    -h | --help) usage ;;
    *) die "unknown option $1 (see --help)" ;;
  esac
done

# --- what to build ----------------------------------------------------------------------------------
# A test build is another app (its own package id and name), so it installs next to the real one and
# can't be taken for it, and it opens only its own host.
if [ -z "$host" ] || [ "$host" = "$production_host" ]; then
  [ -z "$package_id$name" ] || die "--package-id and --name are for test builds; production uses twa-manifest.json"
  target=production host=$production_host
elif [ "$host" = "$staging_host" ]; then
  target=staging package_id=${package_id:-dev.sudosapient.app.staging} name=${name:-Sudo Sapient (staging)}
else
  target=test package_id=${package_id:-dev.sudosapient.app.test} name=${name:-Sudo Sapient (test)}
fi
printf '%s' "$host" | grep -Eq '^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$' ||
  die "--host takes a host name such as example.com, without https://, a port or a path"
if [ -n "$package_id" ]; then
  printf '%s' "$package_id" | grep -Eq '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$' || die "invalid package id $package_id"
fi

# --- signing inputs -----------------------------------------------------------------------------------
[ -n "$keystore" ] || die "no keystore: set ANDROID_KEYSTORE or pass --keystore (README.md: Signing key)"
[ -n "$store_pass_file" ] || die "no keystore password file: set ANDROID_KEYSTORE_PASS_FILE or pass --keystore-pass-file"
key_pass_file=${key_pass_file:-$store_pass_file}
for f in "$keystore" "$store_pass_file" "$key_pass_file"; do
  [ -f "$f" ] && [ -r "$f" ] || die "$f is missing or unreadable"
  real=$(cd "$(dirname "$f")" && pwd -P)/$(basename "$f")
  case "$real" in "$repo"/*) die "$f is inside the repository; keep keys and passwords outside it" ;; esac
done
for f in "$store_pass_file" "$key_pass_file"; do
  [ -z "$(find "$f" -perm /077 2>/dev/null)" ] || echo "build: warning: $f can be read by other users; chmod 600 it" >&2
done
keystore=$(cd "$(dirname "$keystore")" && pwd -P)/$(basename "$keystore")
store_pass_file=$(cd "$(dirname "$store_pass_file")" && pwd -P)/$(basename "$store_pass_file")
key_pass_file=$(cd "$(dirname "$key_pass_file")" && pwd -P)/$(basename "$key_pass_file")

# --- tools ------------------------------------------------------------------------------------------
[ -n "${JAVA_HOME-}" ] && [ -x "$JAVA_HOME/bin/java" ] || die "set JAVA_HOME to a JDK 17"
sdk=${ANDROID_HOME:-${ANDROID_SDK_ROOT-}}
[ -n "$sdk" ] && [ -d "$sdk/platforms" ] || die "set ANDROID_HOME to an Android SDK"
build_tools=$(find "$sdk/build-tools" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | sort -V | tail -n 1)
[ -n "$build_tools" ] && [ -x "$build_tools/apksigner" ] || die "no build-tools with apksigner in $sdk/build-tools"
export JAVA_HOME ANDROID_HOME=$sdk PATH="$JAVA_HOME/bin:$PATH"

# Production builds the committed project without regenerating it, so it must match twa-manifest.json.
if [ "$target" = production ]; then
  want=$(sed -n 's/^[[:space:]]*"appVersionCode":[[:space:]]*\([0-9]*\).*/\1/p' "$here/twa-manifest.json")
  have=$(sed -n 's/^[[:space:]]*versionCode[[:space:]]*\([0-9]*\).*/\1/p' "$here/app/build.gradle")
  [ "$want" = "$have" ] ||
    die "twa-manifest.json has appVersionCode $want but the project has versionCode $have; run node apps/android/generate.js and commit"
  [ ! "$here/twa-manifest.json" -nt "$here/app/build.gradle" ] ||
    echo "build: warning: twa-manifest.json is newer than the project; run node apps/android/generate.js if you changed it" >&2
fi

if [ "$target" = production ] && [ -n "$(git -C "$repo" status --porcelain -- apps/android public/icons 2>/dev/null)" ]; then
  echo "build: warning: apps/android or public/icons has uncommitted changes; a release should come from a commit" >&2
fi

# --- the project, in a copy -------------------------------------------------------------------------
# Production builds the committed project as it is. A test build regenerates the copy with Bubblewrap
# for its host and identity (generate.js), so nothing committed is edited.
mkdir -p "$out"
out=$(cd "$out" && pwd -P)
work="$out/work/$target"
rm -rf "$work"
mkdir -p "$work"
(cd "$here" && cp -R app gradle build.gradle settings.gradle gradle.properties gradlew twa-manifest.json "$work/")
rm -rf "$work/app/build"
if [ "$target" != production ]; then
  echo "Generating the $target project for https://$host ..."
  node "$here/generate.js" --out "$work" --host "$host" --package-id "$package_id" --name "$name" >"$out/generate-$target.log" 2>&1 ||
    die "generating the project failed; see $out/generate-$target.log"
fi
printf 'sdk.dir=%s\n' "$sdk" >"$work/local.properties"

echo "Building the $target APK (Gradle, a few minutes the first time) ..."
# --no-daemon: no Gradle process is left running afterwards.
if ! (cd "$work" && ./gradlew --no-daemon --console=plain --max-workers=2 assembleRelease) >"$out/gradle-$target.log" 2>&1; then
  tail -n 30 "$out/gradle-$target.log" >&2
  die "Gradle failed; the full log is $out/gradle-$target.log"
fi

unsigned="$work/app/build/outputs/apk/release/app-release-unsigned.apk"
[ -f "$unsigned" ] || die "Gradle didn't produce $unsigned"
badging=$("$build_tools/aapt2" dump badging "$unsigned") || die "aapt2 couldn't read $unsigned"
version_code=$(printf '%s\n' "$badging" | sed -n "s/.*versionCode='\([0-9]*\)'.*/\1/p")
version_name=$(printf '%s\n' "$badging" | sed -n "s/.*versionName='\([^']*\)'.*/\1/p")
apk_package=$(printf '%s\n' "$badging" | sed -n "s/^package: name='\([^']*\)'.*/\1/p")

# --- align, sign, verify ----------------------------------------------------------------------------
suffix=$([ "$target" = production ] && echo "" || echo "-$target")
apk="$out/sudo-sapient$suffix-$version_name-$version_code.apk"
[ ! -e "$apk" ] || echo "build: warning: replacing $apk; raise appVersionCode for a build you hand out" >&2
aligned="$work/aligned.apk"
"$build_tools/zipalign" -p -f 4 "$unsigned" "$aligned"
# Passwords are passed as file: references, so they never appear on a command line or in a log.
# apksigner reads one line per use of a file, so a key password in the keystore's file isn't named
# again: without --key-pass it uses the keystore password, as PKCS12 keystores need.
key_pass=()
[ "$key_pass_file" = "$store_pass_file" ] || key_pass=(--key-pass "file:$key_pass_file")
# minSdkVersion 24 means v2 and v3 signatures (v1 is only for Android 6 and older); no v4 .idsig file.
"$build_tools/apksigner" sign --ks "$keystore" --ks-key-alias "$alias" --ks-pass "file:$store_pass_file" "${key_pass[@]}" \
  --v4-signing-enabled false --out "$apk" "$aligned" || die "signing failed (wrong alias or password?)"
rm -f "$aligned"

verify=$("$build_tools/apksigner" verify --verbose --print-certs "$apk") || die "apksigner verify failed"
printf '%s\n' "$verify" >"$apk.verify.txt"
printf '%s\n' "$verify" | grep -q 'Verified using v2 scheme (APK Signature Scheme v2): true' || die "the APK has no v2 signature"
digest=$(printf '%s\n' "$verify" | sed -n 's/^Signer #1 certificate SHA-256 digest: //p')
[ -n "$digest" ] || die "no certificate digest in the apksigner output"
fingerprint=$(printf '%s' "$digest" | tr '[:lower:]' '[:upper:]' | sed 's/../&:/g; s/:$//')

cat <<EOF

Built $apk
  target       $target (https://$host)
  package id   $apk_package
  version      $version_name (versionCode $version_code)
  certificate  SHA-256 $fingerprint
  checked      $apk.verify.txt

For https://$host/.well-known/assetlinks.json, set on that deployment:
  ANDROID_PACKAGE_NAME=$apk_package
  ANDROID_CERT_FINGERPRINTS=$fingerprint
EOF
