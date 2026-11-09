---
"@q9labsai/chalk-client": patch
---

`preconnect` accepts `syncDirectUrl`. When an app builds its client with `syncDirectUrl`, pass the same value so the lobby's warm Sync socket opens at the direct URL and the client adopts it. Without it, the warm socket opens at the regular Sync URL and a direct-first client does not adopt it.
