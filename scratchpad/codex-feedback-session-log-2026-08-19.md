# Chalk Feedback implementation session log

## 2026-08-19

- Settled the product as Feedback rather than Support. Chalk receives reports
  from embedded `<Chalk />`, Chalk web/mobile, and Dashboard. The first version
  has three categories, one message, automatic removable screenshot, automatic
  safe diagnostic evidence, observability-tooling retrieval, and no reply or
  ticket workflow.
- Mapped four existing seams in parallel: Episode Diagnostics CLI and operator
  auth; client Journey/diagnostic context and platform capture gaps; API,
  PostgreSQL, R2, migration, and observability patterns; and React, React Native,
  web, mobile, and Dashboard entry points.
- Ruled that Feedback is a separate durable domain. Tenant principals may
  submit, but only Chalk operator credentials may read. The existing Episode
  Diagnostics domain remains a correlation target rather than Feedback storage.
- Drafted `scratchpad/chalk-feedback-spec-2026-08-19.md` for critique before
  execution. Production remains out of scope.
- Integrated two independent critique passes. Split account and Diagnostic
  Participant authentication, replaced the direct-upload handshake with one
  bounded idempotent request, defined exact v1 contracts and allowlists, made
  screenshots explicitly best effort, hardened operator output, and corrected
  migration, Dashboard gateway, CLI dispatcher, and execution ownership seams.
  The spec is ready for execution with no open product decision.
- Created the isolated `codex/chalk-feedback` worktree and implemented the API
  slice: Feedback domain, PostgreSQL migration and sqlc repository, R2 evidence
  storage, account and Diagnostic Participant intake, Chalk-operator reads,
  audit, metrics, traces, route contracts, and trace-harness proofs. Review
  removed Tenant-account read access and made evidence validation fail closed
  for storage, cookies, telemetry, diagnostics, metadata, and image bytes.
- Verified focused Go packages and exercised the Feedback migration up, down,
  and up against local PostgreSQL 18.3. Production was not touched.
- Added the public client domain behind `SpaceClient.feedback`: bounded evidence
  collection, screenshot and message validation, private Diagnostic Participant
  authentication, idempotent submission, and disposal-safe behavior. The
  credential-bearing transport stays private to the client runtime.
- Added the Chalk-only operator CLI with `feedback list`, `show`, `pull`, and
  `open`. Downloads are size- and checksum-verified, terminal output is escaped,
  and trace launches use strict correlation and host allowlists.
- Added the Dashboard account-boundary route for Feedback intake with its own
  one-megabyte cap while retaining account, CSRF, idempotency, Journey, and W3C
  trace protections. Added vetted web and native root-capture dependencies;
  platform UI work is in progress.
- Completed the React, React Native, Chalk web/mobile, and Dashboard surfaces.
  Each uses its existing utility surface, three exact categories, one message,
  automatic Chalk-root capture, a removable/refreshable preview, safe local
  evidence, and a non-blocking capture fallback. Dashboard uses account+CSRF;
  embedded and mobile use the private Diagnostic Participant boundary.
- Integration review fixed two evidence gaps before dogfood: browser collection
  now summarizes every scoped per-tab telemetry queue and pending Dashboard
  request without reading their values, and embedded Chalk falls back to its
  Episode diagnostic Journey/trace when a host telemetry Journey is absent.
  The local lockfile is frozen-install clean and focused SDK, UI, gateway, and
  type checks pass.
- Blind CLI dogfood found that the first help screen did not explain filters,
  operator credentials, or safe pull behavior. Expanded it into an actionable
  command reference and made unknown flags fail without pretending they need a
  value. CLI error output, exit codes, terminal escaping, and refusal to
  overwrite a non-empty directory behaved as designed.
- Real Helium dogfood could not start because the installed Chrome plugin
  client imports Node built-ins that its Node REPL now forbids. The Helium
  extension is enabled, but native-host diagnostics also report a missing
  allowed extension origin. No fallback browser was used, so this remains a
  tooling blocker rather than product proof.
- Replaced the web surface's misleading More shortcut with a named Feedback
  control across compact, inline, floating, classic, and Chalk control bars.
  Focused control, Space view, dialog, capture, and React type checks pass.
- Tightened the new TypeScript boundaries after integration review. Feedback
  validation and CLI parsing now use concrete contracts instead of `any`,
  shapeless records, or shape-erasing guards; diagnostic events go through the
  existing diagnostics contract validator.
- The first full gate caught new dead exports, duplicate CLI parsing, and
  high-complexity Feedback validators. Split those responsibilities into named
  helpers, removed the dead surface, and reran focused Fallow audits with no
  remaining findings. Restored unrelated lockfile normalization so the lock
  now contains only the two vetted capture dependencies and their transitives.
