---
"@q9labsai/chalk-client": minor
"@q9labsai/chalk-react": minor
---

On the own SFU, keep audio and show "Video paused for network" when the SFU pauses a remote video for a slow link, instead of repulling it. Off-screen video pauses in place without renegotiation. `RemoteMedia` gains `pausedForNetwork`, and tiles take `isVideoPausedForNetwork`. Cloudflare behavior is unchanged.
