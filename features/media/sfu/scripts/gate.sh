#!/usr/bin/env bash
# Chalk SFU gate: format (Go and Markdown), module tidiness, vet and the race-enabled tests.
set -euo pipefail

sfu_root="$(cd "$(dirname "$0")/.." && pwd)"
if [[ -d /usr/local/go/bin ]]; then
  export PATH="/usr/local/go/bin:${PATH}"
fi
export GOTOOLCHAIN="${CHALK_API_GOTOOLCHAIN:-go1.26.10+auto}"
# Git worktrees break Go VCS stamping (exit 128); the gate never needs stamped binaries.
export GOFLAGS="${GOFLAGS:--buildvcs=false}"
repo_root="$(cd "${sfu_root}/../../.." && pwd)"
cd "${sfu_root}"

printf '\n==> Bench reaper tests (fake doctl only)\n'
python3 scripts/bench/test_bench.py
printf '\n==> Deploy script start tests (fake ssh only)\n'
python3 "${repo_root}/infrastructure/sfu/test_deploy.py"
printf '\n==> Template render and deploy branch tests (mocked ssh, doctl, docker)\n'
python3 "${repo_root}/infrastructure/sfu/test_templates.py"
printf '\n==> Shared staging lease and contention tests\n'
python3 "${repo_root}/scripts/staging-sfu/test_staging_lock.py"
node "${repo_root}/scripts/test/run.mjs" node --test "${repo_root}/features/scorecard/contention.test.mjs" "${repo_root}/features/scorecard/own-sfu.test.mjs" "${repo_root}/features/scorecard/cf-sfu-card.test.mjs" "${repo_root}/features/scorecard/nightly-graph.test.mjs" "${repo_root}/features/scorecard/staging-metrics.test.mjs" "${repo_root}/features/scorecard/staging-latency.test.mjs" "${repo_root}/features/scorecard/diagnostics.test.mjs" "${repo_root}/features/scorecard/stats.test.mjs" "${repo_root}/features/scorecard/baseline.test.mjs" "${repo_root}/scripts/prod-proof/latency-stages.test.mjs"

printf '\n==> go version\n'
go version

printf '\n==> Format check\n'
unformatted="$(gofmt -l .)"
if [[ -n "${unformatted}" ]]; then
  echo "These Go files need gofmt:"
  echo "${unformatted}"
  exit 1
fi

printf '\n==> Markdown format check\n'
# Run oxfmt by path: pnpm exec breaks in some git worktrees.
(cd "${repo_root}" && node_modules/.bin/oxfmt --check "features/media/sfu/**/*.md")

printf '\n==> Module tidy check\n'
go mod tidy -diff
(cd protocol && go mod tidy -diff)

printf '\n==> go vet\n'
go vet ./...

printf '\n==> go test -race\n'
if [[ -n "${SFU_TEST_JSON:-}" ]]; then
  mkdir -p "$(dirname "${SFU_TEST_JSON}")"
  # The scorecard reads the JSON events; the log keeps the readable lines. pipefail keeps go test's exit code.
  go test -race -count=1 -json ./... | tee "${SFU_TEST_JSON}" | node "${repo_root}/features/scorecard/scorecard.mjs" go-output
else
  go test -race -count=1 ./...
fi
