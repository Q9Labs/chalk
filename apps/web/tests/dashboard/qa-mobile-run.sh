#!/usr/bin/env bash
set -euo pipefail
out=/Users/agents/lanes/qa-w10-mobile-head
mkdir -p "$out"
collect() {
  status=$?
  trap - EXIT
  rm -f apps/web/tests/dashboard/qa-mobile-driver.mjs
  if [[ -d artifacts/qa-mobile-admission ]]; then
    tar -czf "$out/proof.tgz" artifacts/qa-mobile-admission
  fi
  printf '%s\n' "$status" > "$out/status"
  exit "$status"
}
trap collect EXIT
node --input-type=module - <<'JS'
import {readFile,writeFile} from 'node:fs/promises';
const source=await readFile('apps/web/tests/dashboard/join-browser.mjs','utf8');
await writeFile('apps/web/tests/dashboard/qa-mobile-driver.mjs',source.replace('"./public-admission-browser.mjs"','"./qa-mobile-admission.mjs"').replace('admissionGuestBrowser = await chromium.launch({ headless: true });','admissionGuestBrowser = browser;'));
JS
export QA_PR_HEAD=97305d8aa9190fa859e7ced9e3813b8cae0a7077
export DASHBOARD_ENGINE_DEADLINE_SECONDS=1100
bash apps/web/tests/dashboard/real-engine.sh node apps/web/tests/dashboard/qa-mobile-driver.mjs --admission
