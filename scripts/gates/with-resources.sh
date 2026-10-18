#!/usr/bin/env bash
set -euo pipefail

# Leave room for concurrent checks and Go's compiler subprocesses. Explicit
# caller limits (including CI's smaller test jobs) always take precedence.
gate_cpus=1
workers=1
if [[ "${CI:-}" == true || "${CI:-}" == 1 ]]; then
  gate_cpus="$(node -e 'console.log(require("node:os").availableParallelism())')"
  workers=$((gate_cpus / 2))
  if ((workers < 1)); then workers=1; fi
  if ((workers > 4)); then workers=4; fi
fi
export GOMAXPROCS="${GOMAXPROCS:-$gate_cpus}"
export VITEST_MAX_WORKERS="${VITEST_MAX_WORKERS:-$workers}"
export ERL_FLAGS="${ERL_FLAGS:-+S $workers:$workers}"

# The gate scripts source this file; package aliases execute it as a wrapper.
if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  exec "$@"
fi
