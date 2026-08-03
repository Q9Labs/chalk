# Chalk real-media session log

## 2026-08-03T09:35:05+0500

The local Chalk browser demo now uses the real Cloudflare Realtime SFU path. The credential came from the 1Password CLI item `Cloudflare Realtime SFU chalk-local-dev-20260714` in the `dev` vault, and the app ID matched the Cloudflare Serverless SFU app `chalk-local-dev-20260714`. The secret stays in the process environment and is not recorded here.

The isolated local API database remained `127.0.0.1:55432`. The API restarted without `CHALK_CLOUDFLARE_REALTIME_BASE_URL`, so the adapter used its default `https://rtc.live.cloudflare.com/v1` endpoint. The local SFU stub on port `59200` was stopped after its request log showed no traffic since the previous day.

Verification passed end to end: the local backend returned browser-session `201`, access `201`, and cleanup `204`; the access response identified `cloudflare_sfu`, included Cloudflare's STUN server, and contained a 64-character connection ID; the browser joined with camera and microphone enabled; the join trace reached `live` with `Start media` marked `ok` in `1235 ms`; and a live video element reported `640x480` with ready state `4`.
