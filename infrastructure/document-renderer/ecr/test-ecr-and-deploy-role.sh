#!/usr/bin/env bash
# Offline test of apply-ecr-repository and apply-document-renderer-publish: a fake aws and the real jq prove that --check
# is clean after an apply and reports drift after a change, without touching AWS.
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
mkdir "$work/bin" "$work/state"
cat > "$work/bin/aws" <<'FAKE'
#!/usr/bin/env bash
state="$FAKE_AWS_STATE"
args=("$@")
has() { [[ " ${args[*]} " == *" $1 "* ]]; }
val() { for i in "${!args[@]}"; do [ "${args[$i]}" = "$1" ] && { printf '%s' "${args[$((i+1))]}"; return; }; done; }
case "$1 $2" in
  "sts get-caller-identity") echo 123456789012 ;;
  "configure get") echo ap-southeast-1 ;;
  "ecr describe-repositories") [ -f "$state/repo" ] || exit 254; echo '{"imageTagMutability":"IMMUTABLE","imageScanningConfiguration":{"scanOnPush":true},"encryptionConfiguration":{"encryptionType":"AES256"}}' ;;
  "ecr create-repository") touch "$state/repo" ;;
  "ecr put-image-tag-mutability"|"ecr put-image-scanning-configuration") ;;
  "ecr put-lifecycle-policy") val --lifecycle-policy-text > "$state/lifecycle" ;;
  "ecr set-repository-policy") val --policy-text > "$state/ecr-policy" ;;
  "ecr get-lifecycle-policy") cat "$state/lifecycle" ;;
  "ecr get-repository-policy") cat "$state/ecr-policy" ;;
  "iam put-role-policy") val --policy-document > "$state/role-$(val --policy-name)" ;;
  "iam get-role-policy") cat "$state/role-$(val --policy-name)" ;;
  *) echo "unexpected aws call: $*" >&2; exit 99 ;;
esac
FAKE
chmod +x "$work/bin/aws"
export PATH="$work/bin:$PATH" FAKE_AWS_STATE="$work/state" AWS_REGION=ap-southeast-1
ecr="$root/infrastructure/document-renderer/ecr/apply-ecr-repository"
role="$root/infrastructure/nightly/deploy-role/apply-document-renderer-publish"
"$ecr" --check >/dev/null 2>&1 && { echo "check passed before the repository existed" >&2; exit 1; }
"$ecr" >/dev/null
"$ecr" --check
"$role" >/dev/null
"$role" --check
echo '{}' > "$work/state/lifecycle"
"$ecr" --check >/dev/null 2>&1 && { echo "check missed lifecycle drift" >&2; exit 1; }
echo '{}' > "$work/state/role-chalk-nightly-document-renderer-image-publish"
"$role" --check >/dev/null 2>&1 && { echo "check missed role policy drift" >&2; exit 1; }
echo "ok"
