## Shared rules for every lane

- Repository: /Users/macmini/code/chalk. Read AGENTS.md and GLOSSARY.md first; use glossary vocabulary. Other agents work in this repository: do not edit, create, or delete tracked files; do not commit, push, stash, reset, or create branches. Put every file you create under your lane folder in /Users/macmini/code/chalk/scratchpad/sync-hardening-2026-09-27/.
- Never print or save secrets (Cloudflare app secret, tokens, invite links). The 1Password CLI uses a service account: every `op item get` must pass `--vault dev`.
- Do not touch production (chalkmeet.com, AWS, PlanetScale, DigitalOcean). Local stack and the local development Cloudflare Realtime app are in scope.
- Separate measured facts from inferences. Report failures with exact error text. Write your report file last; its existence signals completion.
- Context: Chalk's media toggles are slow (0.6–0.9s typical, 2.5–4s p95, up to 23s) even on the local stack, and a confirmed bug exists: after Participant A turns the camera off and on, Participant B never receives A's video again (B's `POST .../media/sfu/tracks` calls take ~8.2s three times, then repeat every ~1.2s with HTTP 200, and no renegotiate follows). Earlier reports: lane-a-report.md (code path map), lane-b-report.md (local timings), lane-b/repro-remote-video.mjs (bug repro), ../claude-sync-hardening-session-log-2026-09-27.md.
