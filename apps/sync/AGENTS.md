# Chalk Sync

Elixir/OTP WebSocket sync server and primary `SyncEngine` adapter. Postgres is
the sole durable authority for Session control state, exact event history,
command receipts, and lifecycle intents. Node-local coordinators, ETS queues,
notifications, presence, and SDK replicas are disposable. Redis is optional
acceleration only.

## Working Here

- Always read `README.md` before touching sync code.
- Preserve the tenant-and-Session authority key and semantic Stateholder
  transaction boundary.
- Durable lifecycle comes only from API intents. Socket loss is volatile
  presence and never a durable participant leave.
- Protocol v3 and its generated contract are the production surface. V1 stays
  disabled in production.
- Keep every frame, queue, task set, replay, diagnostic buffer, and retained
  database set explicitly bounded.
- Run the repository-root `pnpm run gate` before committing; it selects this
  app's basic gate whenever Sync files or shared gate inputs change. Run
  `scripts/gate.sh` directly for Credo and the full test suite.
- Commit only after the gate passes and stage only the intended paths with
  `git add -p`.
- Run the required automated review after a nontrivial implementation and
  debrief Hasan using `~/.codex/debrief.md` when requested.
