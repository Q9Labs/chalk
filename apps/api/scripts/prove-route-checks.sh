#!/usr/bin/env bash
# Run inside scripts/gates/with-postgres.sh on Instabox, never on the Air.
set -euo pipefail

cd "$(dirname "$0")/../../.."
if [[ "$(uname -s)" != Linux ]]; then
  echo 'Run this proof on Instabox or Linux CI.' >&2
  exit 2
fi
if [[ "${CHALK_GATE_POSTGRES_READY:-0}" != 1 ]]; then
  echo 'Run through scripts/gates/with-postgres.sh -- on Instabox.' >&2
  exit 2
fi
if [[ -n "$(git status --porcelain --untracked-files=no)" ]]; then
  echo 'Proof needs a clean sandbox checkout.' >&2
  exit 2
fi

base="$(git rev-parse HEAD)"
router=apps/api/internal/httpapi/router.go
proof_dir="$(mktemp -d)"
restore() {
  git restore --staged --worktree -- "$router"
  git switch --detach "$base" >/dev/null
}
trap restore EXIT

echo "PROOF clean head $base"
echo "PROOF machine $(uname -m); cores $(nproc); $(uptime)"
(
  cd apps/api
  go test -vet=off -count=3 -json ./internal/httpapi ./cmd/codegen ./internal/adapters/postgres \
    -run '^(TestAuthorizationRouteMatrix|TestWorkloadAuthorizationRouteMatrix|TestMountedRouteContractCompleteness|TestGeneratedOpenAPIMatchesEndpointContracts|TestDisabledTranscriptionReturnsTypedUnavailable)$'
) > "$proof_dir/clean.json"
python3 - "$proof_dir/clean.json" <<'PY'
import json, statistics, sys
times = {}
for line in open(sys.argv[1]):
    event = json.loads(line)
    if event['Action'] in ('fail', 'skip'):
        raise SystemExit('clean proof failed or skipped: ' + str(event))
    if event['Action'] == 'pass' and event.get('Test') and '/' not in event['Test']:
        times.setdefault(event['Test'], []).append(event['Elapsed'] * 1000)
assert len(times) == 5, times
for name, runs in sorted(times.items()):
    assert len(runs) == 3, (name, runs)
    def display(value):
        return '<10' if value == 0 else f'{value:g}'
    print(f'PROOF PASS {name}: median {display(statistics.median(runs))} ms; range {display(min(runs))}-{display(max(runs))} ms; n=3')
PY

expect_failure() {
  local label="$1" package="$2" test_name="$3" diagnostic="$4"
  local log="$proof_dir/$label.log" status=0
  (cd apps/api && go test -vet=off -count=1 "$package" -run "^$test_name$") > "$log" 2>&1 || status=$?
  if [[ "$status" == 0 ]] || ! grep -Eq "$diagnostic" "$log"; then
    cat "$log"
    echo "PROOF FAILED: $label did not fail for the intended reason" >&2
    exit 1
  fi
  echo "PROOF expected failure $label: scratch commit $(git rev-parse HEAD); exit $status"
  grep -E -- '-{3} FAIL|got 200, want 401|no authorization matrix entry|no typed endpoint declaration' "$log"
}

python3 - "$router" <<'PY'
import pathlib, sys
path = pathlib.Path(sys.argv[1])
source = path.read_text()
source = source.replace('\tmountV1Routes(r, options)', '''\tmountV1Routes(r, options)
    r.Get("/v1/matrix-unprotected", func(w http.ResponseWriter, r *http.Request) {
        writeJSON(w, http.StatusOK, map[string]string{"secret": "matrix-canary"})
    })
    r.Get("/v1/tenants/{tenant_id}/spaces/{space_id}", func(w http.ResponseWriter, r *http.Request) {
        writeJSON(w, http.StatusOK, map[string]string{"secret": "matrix-canary"})
    })''')
path.write_text(source)
PY
gofmt -w "$router"
git -c core.hooksPath=/dev/null -c user.name='Route check proof' -c user.email='route-check-proof@example.invalid' commit --only -m 'proof: mount fake unprotected routes' -- "$router" >/dev/null
expect_failure unprotected ./internal/adapters/postgres TestAuthorizationRouteMatrix 'got 200, want 401'
restore

python3 - "$router" <<'PY'
import pathlib, sys
path = pathlib.Path(sys.argv[1])
source = path.read_text().replace('\tmountV1Routes(r, options)', '''\tmountV1Routes(r, options)
    r.Get("/v1/matrix-undeclared", func(w http.ResponseWriter, r *http.Request) {
        writeJSON(w, http.StatusOK, map[string]string{"status": "fake"})
    })''')
path.write_text(source)
PY
gofmt -w "$router"
git -c core.hooksPath=/dev/null -c user.name='Route check proof' -c user.email='route-check-proof@example.invalid' commit --only -m 'proof: mount fake undeclared route' -- "$router" >/dev/null
expect_failure undeclared ./internal/httpapi TestMountedRouteContractCompleteness 'no typed endpoint declaration.*matrix-undeclared'
restore
echo "PROOF restored clean head $(git rev-parse HEAD)"
