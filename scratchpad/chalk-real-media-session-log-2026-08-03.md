# Chalk real-media session log

## 2026-08-03T09:35:05+0500

The local Chalk browser demo now uses the real Cloudflare Realtime SFU path. The credential came from the 1Password CLI item `Cloudflare Realtime SFU chalk-local-dev-20260714` in the `dev` vault, and the app ID matched the Cloudflare Serverless SFU app `chalk-local-dev-20260714`. The secret stays in the process environment and is not recorded here.

The isolated local API database remained `127.0.0.1:55432`. The API restarted without `CHALK_CLOUDFLARE_REALTIME_BASE_URL`, so the adapter used its default `https://rtc.live.cloudflare.com/v1` endpoint. The local SFU stub on port `59200` was stopped after its request log showed no traffic since the previous day.

Verification passed end to end: the local backend returned browser-session `201`, access `201`, and cleanup `204`; the access response identified `cloudflare_sfu`, included Cloudflare's STUN server, and contained a 64-character connection ID; the browser joined with camera and microphone enabled; the join trace reached `live` with `Start media` marked `ok` in `1235 ms`; and a live video element reported `640x480` with ready state `4`.

## 2026-08-03T10:01:40+0500

The media-control failure was a dormant-connection race. A zero-media join scheduled remote publication discovery before the Cloudflare peer connection had completed its first negotiation. Cloudflare returned HTTP `410` with `session_error` and `Session appears to be disconnected`, which the session layer exposed as the unhelpful `setCameraEnabled was not confirmed` or `setMicrophoneEnabled was not confirmed` message.

The client now defers remote-track pulls until the current connection has negotiated, while a later first local publication still obtains a fresh participant media access payload and replaces the dormant connection. The SDK test suite passed with 55 files and 330 tests. In a fresh local browser room using the real Cloudflare path, camera on/off and microphone on/off each completed sequentially with the join status remaining `live`, no confirmation alert, and no reconnect dialog. A simultaneous camera/microphone toggle remains a separate concurrency edge case and was not used as the success criterion.
