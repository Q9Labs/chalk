# Chalk Sync

Elixir/OTP WebSocket sync server and primary `SyncEngine` adapter. Postgres is
the sole durable authority for Episode control state, exact event history,
command receipts, and lifecycle intents. Node-local coordinators, ETS queues,
notifications, presence, and SDK replicas are disposable. Redis is optional
acceleration only.

## Development

- Read `README.md` before touching sync code.
- Preserve the tenant-and-Episode authority key and semantic Stateholder
  transaction boundary.
- Durable lifecycle comes only from API intents. Socket loss is volatile
  presence and never a durable participant leave.
- Protocol v1 and its generated contract are the production surface.
- Keep every frame, queue, task set, replay, diagnostic buffer, and retained
  database set explicitly bounded.
- Run the repository-root `pnpm run gate` before committing; it selects this
  app's basic gate whenever Sync files or shared gate inputs change. Run
  `scripts/gate.sh` directly for Credo and the full test suite.
