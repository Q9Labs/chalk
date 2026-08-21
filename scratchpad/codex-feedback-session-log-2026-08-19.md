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
