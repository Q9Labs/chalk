# Managed deployment controller session log

- 2026-08-18: Mapped the tracked release path. CI creates immutable image
  digests and a versioned release manifest, but it stops before host delivery.
  The managed runtime package validates and renders a received release but has
  no SSM command, activation controller, rollback ledger, or reboot-time input
  restoration. No live environment or cloud resource was changed.
- 2026-08-18: Set the implementation boundary. A versioned, constrained SSM
  request will invoke a tracked host controller. The controller will fetch
  exact allowlisted runtime inputs from the environment-scoped SSM prefix,
  validate before stopping the stable
  runtime, activate atomically, require aggregate health, roll back on failure,
  and persist only non-secret release metadata so `/run` can be rebuilt after
  reboot. Missing inputs fail by default; only exact IDs passed with repeated
  CI `--exclude-secret` arguments may be absent.
- 2026-08-18: Added the CI-side runner contract and manual workflow edge. The
  runner validates the exact manifest, target, numeric SSM document version,
  environment parameter prefix, and canonical exclusions before sending one
  command. It waits for the host result and accepts only a healthy deployment
  proof. A dry run emits a redacted request for local dogfood without AWS.
- 2026-08-18: Completed the host cutover transaction and focused fake-host
  proof. The controller now accepts staging and production, requires
  `SecureString` env and secret-file inputs, publishes the env and checksummed
  release identity under `/run`, streams and verifies Podman secrets, and
  checks pulled image architecture. Activation and promotion failures follow
  the same fence-and-rollback path as failed health. The reboot test clears
  `/run`, restores exact SSM parameter versions from the durable pointer, and
  re-runs aggregate health. No AWS account or live host was contacted.
- 2026-08-18: Hardened the final trust and durability edges. The pinned SSM
  wrapper now verifies the downloaded controller against the manifest before
  execution; the CI runner rejects untracked or unconstrained documents and
  binds success to the exact request ID. Promotion failures remove unpublished
  durable releases, the active pointer checks every rendered-runtime hash, and
  certificate/private-key pairs must match. The final focused suite, config
  smoke, and fake-host deploy/rollback/reboot/tamper flow all pass with fake
  inputs only.
- 2026-08-18: The terminal recording caught an stdin-sensitive ledger write
  that the closed-input harness had allowed through. Switched that JSON build
  to explicit input-free mode and made the harness require one healthy ledger
  record, so both interactive and SSM shells follow the same promotion path.
- 2026-08-19: An authorized live rollout exposed a Podman 4.9 input contract
  that the fake host did not model: `secret create ... -` rejects a regular
  file redirected to standard input. The stable runtime was restored from its
  pinned pointer. Secret rotation now sends bytes through a real pipe and uses
  Podman's atomic `--replace` path; the fake Podman requires both properties.
