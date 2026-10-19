#!/usr/bin/env bash
# Run through scripts/gates/remote.sh -- bash apps/api/scripts/proof-direct-admission.sh.
# This restores the policy-only repository only inside the throwaway checkout.
set -euo pipefail
cd "$(dirname "$0")/../../.."
export GATE_BASE_REF=168596701
pnpm run check:generated
if [[ "${1:-}" != --database ]]; then
  bash scripts/gates/with-postgres.sh -- bash apps/api/scripts/proof-direct-admission.sh --database
  bash apps/api/scripts/gate.sh
  exit
fi
file=apps/api/internal/adapters/postgres/episode_lifecycle_create.go
backup=$(mktemp)
cp "$file" "$backup"
restore() { cp "$backup" "$file"; rm -f "$backup"; }
trap restore EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
git show "$GATE_BASE_REF:$file" > "$file"
set +e
go test -C apps/api -vet=off ./internal/adapters/postgres -run '^TestDirectAdmissionHTTP$' -v -count=1 > /tmp/direct-admission-baseline.log 2>&1
status=$?
set -e
cat /tmp/direct-admission-baseline.log
if [[ "$status" == 0 ]] || ! grep -q 'direct admission did not return normal access' /tmp/direct-admission-baseline.log; then
  echo 'Baseline did not reproduce the admission failure' >&2
  exit 1
fi
cp "$backup" "$file"
echo 'BASELINE REPRODUCED; rerunning identical HTTP/PostgreSQL matrix with direct admission'
go test -C apps/api -vet=off ./internal/adapters/postgres -run '^TestDirectAdmissionHTTP$' -v -count=1
