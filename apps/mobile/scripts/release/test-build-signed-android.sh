#!/usr/bin/env bash

set -euo pipefail

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
build_script="$script_dir/build-signed-android.sh"
test_dir=$(mktemp -d "${TMPDIR:-/tmp}/chalk-android-signing-test.XXXXXX")
fake_bin="$test_dir/bin"
fixture_keystore="$test_dir/fixture.jks"
fixture_cert_pem="$test_dir/fixture-cert.pem"
fixture_cert_der="$test_dir/fixture-cert.der"
fixture_alias="fixture-release"
fixture_store_password="fixture-store-password"
fixture_key_password="fixture-key-password"
keytool_log="$test_dir/keytool.log"
build_marker="$test_dir/build.marker"
system_path=$PATH

cleanup() {
  rm -rf -- "$test_dir"
}

trap cleanup EXIT HUP INT TERM

mkdir -p "$fake_bin"
printf '%s\n' 'fixture-keystore' > "$fixture_keystore"
openssl req -x509 -newkey rsa:2048 -nodes \
  -keyout "$test_dir/fixture-cert.key" \
  -out "$fixture_cert_pem" \
  -subj '/CN=Chalk Android signing fixture' \
  -days 1 >/dev/null 2>&1
openssl x509 -in "$fixture_cert_pem" -outform DER -out "$fixture_cert_der"

expected_keystore_sha256=$(shasum -a 256 "$fixture_keystore" | sed 's/ .*//')
expected_certificate_sha256=$(openssl x509 -inform DER -in "$fixture_cert_der" -noout -fingerprint -sha256 | sed 's/.*=//')
mismatched_certificate_sha256='00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF'

cat > "$fake_bin/op" <<'FAKE_OP'
#!/usr/bin/env bash

set -euo pipefail

[[ "${1:-}" == read ]] || exit 1
out_file=''
for ((index = 1; index <= $#; index += 1)); do
  if [[ "${!index}" == --out-file ]]; then
    next_index=$((index + 1))
    out_file=${!next_index}
    break
  fi
done
[[ -n "$out_file" ]] || exit 1

reference=${!#}
case "$reference" in
  */keystore)
    cp "$FIXTURE_KEYSTORE" "$out_file"
    ;;
  */password)
    printf '%s' "$FIXTURE_STORE_PASSWORD" > "$out_file"
    ;;
  */key_password)
    printf '%s' "$FIXTURE_KEY_PASSWORD" > "$out_file"
    ;;
  */key_alias)
    printf '%s' "$FIXTURE_ALIAS" > "$out_file"
    ;;
  *)
    exit 1
    ;;
esac
FAKE_OP

cat > "$fake_bin/jq" <<'FAKE_JQ'
#!/usr/bin/env bash

set -euo pipefail

while [[ "${1:-}" == -* ]]; do
  shift
done
filter=${1:-}
case "$filter" in
  .vault)
    printf '%s\n' fixture-vault
    ;;
  .android.signing_item_id)
    printf '%s\n' fixture-item
    ;;
  .android.keystore_sha256)
    printf '%s\n' "$EXPECTED_KEYSTORE_SHA256"
    ;;
  .android.certificate_sha256)
    printf '%s\n' "$EXPECTED_CERTIFICATE_SHA256"
    ;;
  *)
    exit 1
    ;;
esac
FAKE_JQ

cat > "$fake_bin/keytool" <<'FAKE_KEYTOOL'
#!/usr/bin/env bash

set -euo pipefail

printf '%s\n' "$@" >> "$KEYTOOL_LOG"
case "${1:-}" in
  -exportcert)
    cat "$FIXTURE_CERT_DER"
    ;;
  -printcert)
    printf 'SHA256: %s\n' "$EXPECTED_CERTIFICATE_SHA256"
    ;;
  *)
    exit 1
    ;;
esac
FAKE_KEYTOOL

cat > "$fake_bin/jarsigner" <<'FAKE_JARSIGNER'
#!/usr/bin/env bash

exit 0
FAKE_JARSIGNER

cat > "$fake_bin/pnpm" <<'FAKE_PNPM'
#!/usr/bin/env bash

set -euo pipefail

printf '%s\n' reached > "$BUILD_MARKER"
exit 42
FAKE_PNPM

chmod 700 "$fake_bin"
chmod 700 "$fake_bin"/*

run_case() {
  local case_name=$1
  local expected_keystore=$2
  local expected_certificate=$3
  local case_log="$test_dir/$case_name.log"
  local status=0

  rm -f -- "$build_marker" "$keytool_log" "$case_log"
  EXPECTED_KEYSTORE_SHA256=$expected_keystore \
    EXPECTED_CERTIFICATE_SHA256=$expected_certificate \
    FIXTURE_ALIAS=$fixture_alias \
    FIXTURE_KEY_PASSWORD=$fixture_key_password \
    FIXTURE_KEYSTORE=$fixture_keystore \
    FIXTURE_CERT_DER=$fixture_cert_der \
    FIXTURE_STORE_PASSWORD=$fixture_store_password \
    KEYTOOL_LOG=$keytool_log \
    BUILD_MARKER=$build_marker \
    PATH="$fake_bin:$system_path" \
    RUNNER_TEMP="$test_dir" \
    SIGNED_OUTPUT_DIR="$test_dir/output" \
    bash "$build_script" > "$case_log" 2>&1 || status=$?

  printf '%s\n' "$status"
}

assert_file_exists() {
  [[ -f "$1" ]] || {
    printf 'Expected file was not created: %s\n' "$1" >&2
    exit 1
  }
}

assert_file_absent() {
  [[ ! -e "$1" ]] || {
    printf 'Unexpected file was created: %s\n' "$1" >&2
    exit 1
  }
}

assert_log_contains() {
  grep -Fq -- "$1" "$2" || {
    printf 'Expected %s in %s\n' "$1" "$2" >&2
    exit 1
  }
}

matching_status=$(run_case matching "$expected_keystore_sha256" "$expected_certificate_sha256")
[[ "$matching_status" != 0 ]] || {
  printf 'Matching identity unexpectedly reached a successful build.\n' >&2
  exit 1
}
assert_file_exists "$build_marker"
assert_log_contains '-exportcert' "$keytool_log"
assert_log_contains '-storepass:file' "$keytool_log"
assert_log_contains 'store.password' "$keytool_log"
assert_log_contains '-alias' "$keytool_log"
assert_log_contains "$fixture_alias" "$keytool_log"

mismatched_certificate_status=$(run_case mismatched-certificate "$expected_keystore_sha256" "$mismatched_certificate_sha256")
[[ "$mismatched_certificate_status" != 0 ]] || {
  printf 'Certificate mismatch unexpectedly passed preflight.\n' >&2
  exit 1
}
assert_file_absent "$build_marker"

mismatched_keystore_status=$(run_case mismatched-keystore 00 "$expected_certificate_sha256")
[[ "$mismatched_keystore_status" != 0 ]] || {
  printf 'Keystore mismatch unexpectedly passed preflight.\n' >&2
  exit 1
}
assert_file_absent "$build_marker"

printf '%s\n' 'Android signing preflight regression tests passed.'
