# Undici security session log — 2026-07-19

- 2026-07-19 13:29 PKT — Confirmed the workspace resolves `undici@7.28.0` through `jsdom@29.1.1` and `miniflare@4.20260701.0`.
- 2026-07-19 13:34 PKT — Confirmed `origin/master` has the identical lockfile and GitHub marks CVE-2026-9697 and CVE-2026-6734 fixed by `undici@7.28.0`; no dependency edit is required.
- 2026-07-19 13:35 PKT — `pnpm install --frozen-lockfile` accepted the lock unchanged, `pnpm audit` reported zero vulnerabilities, and a focused OSV scan of `pnpm-lock.yaml` reported no issues.
- 2026-07-19 13:36 PKT — The full `pnpm run gate` stopped in `security:osv` because it also scans untracked `.private/realtime-examples` lockfiles containing 275 unrelated known vulnerabilities; filed complaint #2552. No product lockfile finding involved `undici@7.28.0`.
- 2026-07-19 13:42 PKT — Removed the Lefthook `post-commit` Codex review trigger and updated API contributor instructions to require the explicit review command. The manual `pnpm run review:commit` entry remains available.
- 2026-07-19 13:47 PKT — Verified Lefthook dumps only `pre-commit`, running the removed `post-commit` stage executes no command, and `.git/hooks/post-commit` is absent. A clean-worktree gate passed hygiene, Fallow, Semgrep, secrets, and OSV after generating the ignored atlas and starting disposable migrated Postgres instances, then stopped on the reproducible unchanged API test failure `observation conflict = invalid provider publication id`; filed complaints #2554 and #2556.
