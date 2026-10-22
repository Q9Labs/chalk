---
"@q9labsai/chalk-client": minor
"@q9labsai/chalk-react": patch
"@q9labsai/chalk-react-native": patch
---

Add optional Sync health to connection snapshots without changing the public status union. Treat brief pong loss as non-blocking degradation; require sustained silence for recovery and stable pongs to clear it. Bound ephemeral reaction acknowledgements to five seconds without replaying them. Keep recovery notices non-blocking and chat readable, and disable reaction sending and media enable controls until live while preserving local mute.

Guard media enabling at the SDK controller boundary for all web, native, and imperative callers, including retries, requests, and share replacement. Keep private camera preview and media off available during recovery. Retain off intents until Sync confirms them after reconnect, clear video even if screen-audio cleanup fails, and treat already-absent local publications as successfully off. Keep hand controls available while reaction sending is disabled.

Keep device menus and camera selection usable during recovery, preserve the screen-share action identity, and serialize every source publication, including initial join, through revisioned workers. Projections cannot confirm or reject newer intent; explicit host pauses are scoped to their operation generation. Recheck desired state after capture and before publishing, so a late initial capture cannot enable a device after Off. Start the silence budget only after sending the first connection probe.
