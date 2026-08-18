# Managed deployment dogfood — 2026-08-18

Scope: local operator fronts only. No AWS CLI, GitHub API, network host, or live deployment was contacted. All release, instance, request, and image values were synthetic.

## Commands and outcomes

- `pnpm run release:managed:ci -- --help` exited 0. The front door lists the manifest, staging/production environment, region, instance, pinned document/version, parameter prefix, request ID, log group, repeated exact `--exclude-secret`, timeout, and `--dry-run` flags. It also explains that missing runtime inputs need exact exclusions and that wildcards are rejected.
- A realistic schema v2 temporary manifest (two affected components, immutable fake image digests, arm64, database/protocol compatibility, and runtime artifact checksums) plus the exact tracked `infrastructure/managed-episode/ssm/chalk-managed-episode-deploy.json` ran with `--dry-run` and exited 0. The proof showed the synthetic target, request, sorted exclusions `api-env` and `sync-env`, manifest/document SHA-256 metadata, the content-addressed controller version, and `ManifestBase64: <base64:1598-bytes>` rather than encoded manifest bytes.
- An invalid fake exclusion (`no-such-secret`) exited 1 with the concise message `unknown excluded secret ID: no-such-secret`.
- `infrastructure/managed-episode/scripts/test-deployment-controller` exited 0. This fake-host harness exercises malformed requests, duplicate/unknown/wildcard exclusions, missing and empty inputs, unsupported types, excluded-input restore, staging, stable promotion, health rollback, failed rollback fencing, durable-promotion cleanup, reboot restore with exact SSM versions, secret streaming without ledger leakage, durable runtime tamper refusal, and the tracked SSM document safety contract. The SSM contract also requires the wrapper to verify the downloaded controller digest before execution.

## UX findings

The dry-run is easy to use and safely reviewable: all high-value deployment fields remain visible while the manifest payload is replaced by a byte-count placeholder. The exact exclusions are visible in both the request and SSM parameters. The help text makes the missing-input rule and exclusion syntax understandable, and invalid IDs fail before any host action.

The harness output is intentionally terse (one PASS line); its internal assertions cover the failure-path messages and redaction checks. The controller's missing-input failure is explicit (`required SSM runtime input is missing: <canonical-id>`), and the harness separately verifies that excluded missing/empty inputs are recorded as missing and not recreated during restore.

The final terminal capture found one real issue: the ledger JSON builder still
read standard input, so an interactive host shell could wait forever at
promotion while a closed-input shell could write no record. The builder now
runs input-free, and the harness requires one valid healthy ledger record.

The redacted terminal transcripts and proof images remain local and untracked
under `scratchpad/screenshots/`, as required for generated debug evidence in
the public repository.

No AWS account, live host, or production file was touched.
