# Chalk Sync

Elixir/OTP WebSocket sync server, the primary `SyncEngine` adapter. One
authoritative writer per room (`Rooms.RoomServer`), pure event-sourced room core,
`Stateholder` and `Auth.TokenVerifier` ports with vendor/dev specifics in
adapters, language-neutral JSON protocol in `ChalkSync.Protocol`. Real-time
state never touches Postgres.

## Working Here

- Always read `README.md` before touching sync code — it holds the invariants
  this server must preserve.
- Run the gate before committing: `scripts/gate.sh`.
- Commit once the gate passes; stage only your scope (`git add -p`).
- After committing, run an auto code review of the commit (`codex review
--commit <sha>`) per `~/.codex/auto-code-review.md` OR let the post-commit hook
  run it automatically. It is slow — wait for it to exit and relay its findings.
- Debrief Hasan on the change per `~/.codex/debrief.md`.
