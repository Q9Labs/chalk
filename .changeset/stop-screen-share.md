---
"@q9labsai/chalk-client": patch
"@q9labsai/chalk-react-native": patch
---

Stopping a screen share no longer fails with "Couldn't stop screen sharing" when the share is the only thing you publish, or when the media node has already dropped the session. A stop now counts a gone session as stopped, and you can share again afterwards.
