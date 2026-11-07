---
"@q9labsai/chalk-client": minor
---

On the own SFU, a failed or lasting disconnected network path first restarts ICE on the same session, so publications and subscriptions stay. If the restart does not reconnect within 8 seconds, or the session is gone, the client reports a recoverable failure and the session is replaced as before. `SFUMediaCapabilities` gains `iceRestart`. Cloudflare behavior is unchanged.
