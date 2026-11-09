---
"@q9labsai/chalk-client": minor
"@q9labsai/chalk-react-native": minor
---

An app can pass `syncDirectUrl` so the Sync socket tries a direct URL first and falls back to the regular Sync URL when the direct attempt fails or takes longer than 2.5 seconds. After a failure the client skips the direct URL for 10 minutes. Without `syncDirectUrl`, nothing changes.
