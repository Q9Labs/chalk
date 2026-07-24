# Live media toggle production fix session log

- 2026-07-24 11:35 PKT — Reproduced camera and microphone control failures in
  the production web meeting. The Sync response was
  `dependency_unavailable`; no corresponding provider-operation receipt reached
  the API.
- 2026-07-24 11:46 PKT — Traced the failure to boot composition: the configured
  provider-bridge media plane was passed to the durable consumer but was not
  installed where live room sessions resolve media dependencies.
- 2026-07-24 11:53 PKT — Identified two follow-on blockers behind the first
  failure: live requests omitted the participant generation, and the API treated
  browser-owned publication grants as unsupported.
- 2026-07-24 12:06 PKT — Implemented regression coverage for shared Sync adapter
  installation, generation-bound disable and enable payloads, and authorization-
  only publication grants. Focused API provider-bridge and trace-harness tests
  passed.
- 2026-07-24 12:08 PKT — Sync's full gate passed with 401 tests and no failures.
  The first API gate attempt exposed migration drift in the reusable local
  database, so verification moved to a fresh disposable Postgres instance
  without changing existing local data.
- 2026-07-24 12:12 PKT — The complete API gate passed against the freshly
  migrated database, including integration tests, lifecycle smoke, vet,
  Staticcheck, and vulnerability analysis. The required local performance run
  also completed and wrote timestamped Markdown and HTML reports.
- 2026-07-24 12:22 PKT — The full canonical repository release gate passed,
  including security scans, service-backed API and Sync checks, generated
  contract drift, workspace tests and builds, recorder validation, Publint, and
  package TypeScript resolution.
- 2026-07-24 13:04 PKT — Deployed the generation-bound media-target fix to the
  production managed meeting runtime. The immutable API and Sync images passed
  source-revision, ARM64, service-readiness, and watchdog checks.
- 2026-07-24 13:08 PKT — Live browser output exposed a second failure: API CORS
  preflight omitted `PUT`, so the client could not close active SFU tracks after
  disabling a publication. Added `PUT` to the public API CORS contract and a
  regression assertion that preflights the same method.
