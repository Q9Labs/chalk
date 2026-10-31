---
"@q9labsai/chalk-client": patch
---

Repair silent remote audio on the listener from what it observes. About every half second the client pulls any enabled remote microphone it is not receiving, and re-pulls one whose packets stop for more than a second and a half, retrying about once a second for as long as the speaker's microphone is enabled. If nothing the listener should hear flows, it reconnects its receive session, backing off while it stays silent. A receive connection that never connected is replaced before its first pull, which removes the 5 second first-pull delay.
