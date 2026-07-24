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
- 2026-07-24 14:04 PKT — The CORS release passed production preflight, but the
  next live attempt exposed a third failure: Cloudflare rejected an add-track
  operation after 5.335 seconds and the SDK exhausted its media recovery
  budget. Production was using the expected ten-second provider timeout, and a
  host-side provider probe ruled out DNS, TLS, credentials, and outbound
  connectivity.
- 2026-07-24 14:06 PKT — Cloudflare's current session contract explains the
  five-second signature: follow-up track operations wait up to five seconds for
  a connected PeerConnection. The SDK had marked media live immediately after
  applying the first SDP answer, while peer and ICE state could still be new.
  It also sent a false-mode close without the required SDP offer. Implemented a
  bounded connection barrier, explicit force-close signaling, and fresh opaque
  track names for every publication attempt. All 237 TypeScript client tests
  and package type checks passed.
- 2026-07-24 14:09 PKT — Hardened the API's add-track adapter after confirming
  that Cloudflare error fields were previously discarded during JSON decoding.
  The adapter now validates top-level and per-track failures and exact local
  result identity, rejects malformed, duplicate, missing, and unexpected
  results, and keeps provider descriptions and media identifiers out of
  returned errors. Focused Go tests and diagnostics passed.
- 2026-07-24 14:12 PKT — The full canonical repository gate passed with the
  connection-readiness, forced-close, publication-identity, and provider-
  response fixes. Verification included API and Sync service gates, all affected
  workspace tests and builds, contract drift checks, security analysis,
  recorder infrastructure validation, and package publication checks.
- 2026-07-24 14:29 PKT — The final bounded Codex review launched but its stream
  was interrupted before it returned findings; the process did not remain
  running. This is a failed review, not review coverage, and the two-run handoff
  limit prevents another attempt. The implementation remains covered by the
  focused tests and complete green repository gate.
- 2026-07-24 14:39 PKT — Published clean, immutable ARM64 API and Sync images
  from source revision `3866ae51`, rendered a digest-pinned runtime manifest,
  and promoted it through the production installer. Image architecture,
  revision labels, service readiness, tunnel readiness, and the runtime
  watchdog all passed. The promotion briefly logged an image-not-known failure
  after installing the new Quadlets and before pulling their digests; the
  installer then pulled the images and completed successfully.
- 2026-07-24 14:42 PKT — Deployed the matching web bundle to the `chalk`
  Cloudflare Pages production project. The custom-domain landing page, room
  route, and meeting-broker health endpoint returned HTTP 200, and the deployed
  room asset contained the new peer-connection barrier.
- 2026-07-24 14:45 PKT — Exercised the production React meeting flow in Chrome:
  joined with live media, confirmed camera off and back on, confirmed microphone
  mute and unmute, and left the room cleanly. The controls returned to their
  opposite confirmed states after every operation, and the browser emitted no
  warning or error logs. Public API and Sync health and readiness returned HTTP
  200, and the real `PUT` media preflight returned HTTP 204 with the expected
  origin, headers, and method.
