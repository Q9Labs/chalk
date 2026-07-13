# Stop all gopls processes — session log

- 2026-07-13 03:05 Asia/Karachi — Initial `pgrep -fl gopls` listed 6 exact-name processes (PIDs 29551, 29589, 39443, 39482, 57502, 57583). Sent SIGTERM using `pkill -TERM -x gopls`; after a brief wait, zero exact-name `gopls` processes remained. SIGKILL was not required. Final `pgrep -fl gopls` was empty.
2026-07-13T05:05:32+05:00 — Found 4 exact-name `gopls` processes via `pgrep -fl gopls`; sent `pkill -TERM -x gopls`; after a brief wait, verification showed zero exact `gopls` processes remained. No SIGKILL was needed.
2026-07-13T06:05:38+05:00 — Found 10 exact-name `gopls` processes via `pgrep -fl gopls`; sent `pkill -TERM -x gopls`; after a brief wait, verification showed zero exact `gopls` processes remained. No SIGKILL was needed. `CODEX_HOME` was unset, so automation memory was written under `/Users/macmini/.codex`.
