# Language ratchet session log — 2026-08-03

## 2026-08-03

- Read `GLOSSARY.md` first. The ratchet must enforce case-insensitive word-boundary counts for `meeting`, `conference`, `videoconference`, `room`, `session`, `attendee`, and the `waitingroom`/`waiting_room`/`waiting-room` forms, with counts tracked per surface and allowed to decrease only through an explicit baseline update.
- Inspected the root gate and tool conventions. The implementation will use a private `tools/language-ratchet` workspace package, and the root smart gate will run it on every gate invocation.
- Installed the 16-workspace dependency set with `pnpm install`, added the streaming counter, baseline update/check modes, focused tests, and unconditional gate wiring.
- Generated the baseline from an isolated Git snapshot containing the exact post-commit tracked file set. The isolated check passed; the remote M4 root gate also passed routing tests, the language ratchet, hygiene, and secret scanning.
- The linked worktree Git index and shared object database are outside the writable sandbox, so staging and committing could not run. The Codex review CLI also failed to initialize its app-server client under the sandbox.
