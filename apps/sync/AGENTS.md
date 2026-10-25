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
  presence; only grace plus empty-room linger can request an ordinary Episode end.
- Protocol v1 and its generated contract are the production surface.
- Keep every frame, queue, task set, replay, diagnostic buffer, and retained
  database set explicitly bounded.
- Run the repository-root `pnpm run gate` before committing; it selects this
  app's basic gate whenever Sync files or shared gate inputs change. Run
  `scripts/gate.sh` directly for Credo and the full test suite.

### Abandoned-Episode compatibility

Presence never marks a participant left or changes attendance or media. Any live
participant connection renews the one shared Episode lease. After 120 seconds
without renewal, the existing customer linger can end the Episode through its
normal operation and recording cleanup. Reconnect before end cancels this
window, on published SDKs as well as head; after end use `episode_ended`.
Each Sync startup/database recovery grants a fresh 120-second grace before
serving traffic; inference pauses without a live Sync session witness. Replace
the whole server fleet with lease-aware Sync before relying on cleanup. No SDK
upgrade is needed. See README.md for deployment order and the Sync-cutoff trade-off.
