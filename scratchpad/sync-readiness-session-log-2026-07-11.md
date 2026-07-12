# Sync readiness session log — 2026-07-11

- 15:04 PKT — Started a read-only go-live readiness review of `apps/sync`.
- 15:04 PKT — Read repository, sync-server, and Chalk status workflow instructions. The existing README explicitly lists Redis, signed token verification, capability enforcement, volatile streams, and schema-generated protocol types as unfinished.
- 15:04 PKT — Confirmed the worktree already contains unrelated user/agent changes; the review will preserve them.
- 15:06 PKT — Ran `apps/sync/scripts/gate.sh`: format, warning-free compile, Credo, and 38 tests all passed.
- 15:07 PKT — Ran a production configuration boot check. It failed with `CHALK_SYNC_TOKEN_VERIFIER must be set in prod`; only the unsigned development verifier exists.
- 15:09 PKT — Confirmed there is no Redis stateholder, release/container/deployment setup, Elixir CI job, metrics/telemetry instrumentation, readiness check, rate limiting, load test, or production soak evidence in the reviewed scope.
- 15:10 PKT — Confirmed the generated TypeScript protocol is exported, but no client transport consumes it. The sync server keys state by `room_id`, while the API model gives participants and occurrences a `session_id`; sync currently has no session boundary.
- 15:10 PKT — Readiness verdict: the core prototype is coherent and locally tested; the production service is not ready to go live.
