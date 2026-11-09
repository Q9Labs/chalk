---
"@q9labsai/chalk-client": minor
---

`preconnect` takes `keepWarmMs` (0 to 16000, default 0). Sync closes an unused socket after 5 s, so while the window lasts the SDK replaces each socket that ages out with a new one, and the first join in the tab adopts whichever is open. Calling `preconnect` while a socket is upgrading or open never starts a second upgrade, and a failed upgrade ends the window. The socket is not tied to a Space, so it also serves the next call after a leave. `releasePreconnect()` closes it and stops keeping one.
