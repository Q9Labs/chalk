#!/usr/bin/env bash
set -euo pipefail

script_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
fixture="$(mktemp -d)"
trap 'rm -rf -- "$fixture"' EXIT

python3 - "$fixture/image-manifest.json" <<'PY'
import json, sys
with open(sys.argv[1], 'w', encoding='utf-8') as file:
    json.dump({'schema_version': 'chalk_recorder_cpu_image.v1',
               'bootstrap_server_name': 'issuer.example',
               'bootstrap_ca_sha256': 'a' * 64}, file)
PY
digest="sha256:$(shasum -a 256 "$fixture/image-manifest.json" | cut -d' ' -f1)"

python3 "$script_root/verify-bootstrap-name.py" --manifest "$fixture/image-manifest.json" \
  --image-digest "$digest" --bootstrap-endpoint 'https://issuer.example:8444' >"$fixture/claims.env"
grep -Fqx 'CHALK_RECORDER_FLEET_BOOTSTRAP_SERVER_NAME=issuer.example' "$fixture/claims.env"
grep -Fqx "CHALK_RECORDER_FLEET_BOOTSTRAP_NAME_IMAGE_DIGEST=$digest" "$fixture/claims.env"
if python3 "$script_root/verify-bootstrap-name.py" --manifest "$fixture/image-manifest.json" \
  --image-digest "$digest" --bootstrap-endpoint 'https://other.example:8444' >"$fixture/rejected.env" 2>/dev/null; then
  echo 'mismatched bootstrap endpoint was accepted' >&2
  exit 1
fi
if python3 "$script_root/verify-bootstrap-name.py" --manifest "$fixture/image-manifest.json" \
  --image-digest "sha256:$(printf '%064d' 0)" --bootstrap-endpoint 'https://issuer.example:8444' >"$fixture/rejected.env" 2>/dev/null; then
  echo 'wrong image digest was accepted' >&2
  exit 1
fi
