---
"@q9labsai/chalk-client": patch
---

Wait half a second before the first pull of a microphone, camera or screen publication that appears after the client has joined. The API announces a publication before its publisher's connection is up, and an early pull could fail so that the provider kept failing that track, leaving the participant silent for the whole call. Publications already present at join are still pulled at once.
