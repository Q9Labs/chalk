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
  presence; only API expiry of the shared presence lease requests a durable Leave.
- Protocol v1 and its generated contract are the production surface.
- Keep every frame, queue, task set, replay, diagnostic buffer, and retained
  database set explicitly bounded.
- Run the repository-root `pnpm run gate` before committing; it selects this
  app's basic gate whenever Sync files or shared gate inputs change. Run
  `scripts/gate.sh` directly for Credo and the full test suite.

### Dropped-participant compatibility

Presence expiry owns one participant generation and one issued/confirmed entry.
A later entry, including an older Sync writer's entry, cannot be evicted by a
previous lease. Disabling entry ownership invalidates all existing leases;
expiry also pauses while enforcement is off. Re-enabling it does not reuse
those discarded leases. Compatibility-mode entries and entries served only by
old Sync have no renewable presence lease and do not receive automatic dropped
cleanup.
Use lease-aware Sync for the whole fleet before relying on empty-room cleanup.
Each lease-aware Sync startup or database-session recovery grants all current
participants 120 seconds to reconnect; expiry pauses while no such node is live.
The updated TypeScript SDK automatically requests fresh normal admission after
`presence_expired` recovery while the Episode is active. Older SDKs and recovery
through old Sync do not support that automatic long-drop rejoin. Shared
`participant_left` events keep their existing `left`/`removed` reasons, so older
observers can still read them. Upgrade the SDK with Sync for long-drop recovery.
