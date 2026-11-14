---
"@q9labsai/chalk-client": patch
---

A media pause during Sync recovery no longer starts a 30 s idle-release timer for a microphone or camera that holds no live capture. After a connection failed, those timers stayed pending on a client that had already released its tracks.
