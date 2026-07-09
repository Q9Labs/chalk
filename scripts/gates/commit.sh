#!/usr/bin/env bash
set -euo pipefail

# Fail if the gate relies on placeholder, no-op, weak, missing, or generated-stub scripts/contracts.
pnpm run gate:hygiene

# Run deterministic JS/TS codebase intelligence for changed-code risk, dead code, duplication, complexity, and dependency hygiene.
pnpm run static:fallow

# Report health score, hotspots, and refactor targets so new smell cannot hide behind passing tests.
pnpm run static:fallow:health

# Run custom Semgrep rules for security, forbidden APIs, architecture, and agent-safety patterns.
pnpm run static:semgrep

# Scan the repo for API keys, tokens, passwords, private keys, and credential leaks.
pnpm run security:secrets

# Scan dependency manifests and lockfiles for known vulnerabilities across supported ecosystems.
pnpm run security:osv

# Run the focused Go API gate when the API app is present.
if [[ -x apps/api/scripts/gate.sh ]]; then
  apps/api/scripts/gate.sh
fi

# Ensure generated OpenAPI and SDK contracts are current without mutating files.
pnpm run check:sdk-generated

# Enforce package.json dependency/version policy across the monorepo.
pnpm run deps:syncpack

# Catch typos in identifiers, comments, docs, config, and user-facing copy.
pnpm run lint:spelling

# Require meaningful source files to have matching tests unless explicitly excluded.
pnpm run test:presence

# Check formatting without modifying files.
pnpm run format:check

# Typecheck the monorepo through Turbo.
pnpm run check-types

# Run the full repository lint task after placeholder scripts are fixed.
pnpm run lint

# Run the repository test task after placeholder scripts are fixed.
pnpm run test

# Run coverage thresholds across packages/apps that support tests.
pnpm run test:coverage

# Build apps/packages through Turbo.
pnpm run build

# Validate publishable package exports, files, entry points, and runtime/bundler compatibility.
pnpm run package:publint

# Validate TypeScript declaration/package resolution behavior across module modes.
pnpm run package:attw
