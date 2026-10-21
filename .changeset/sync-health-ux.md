---
"@q9labsai/chalk-client": minor
"@q9labsai/chalk-react": patch
"@q9labsai/chalk-react-native": patch
---

Add optional Sync health to connection snapshots without changing the public status union. Treat brief pong loss as non-blocking degradation; require sustained silence for recovery and stable pongs to clear it. Bound ephemeral reaction acknowledgements to five seconds without replaying them. Keep recovery notices non-blocking and chat readable, and disable reaction sending and media enable controls until live while preserving local mute.
