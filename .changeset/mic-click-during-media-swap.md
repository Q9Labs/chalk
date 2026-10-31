---
"@q9labsai/chalk-client": patch
---

Apply a microphone or camera click made while the media connection is being replaced, for example while the camera moves to a fresh SFU connection, instead of dropping it. The click now waits for the call to be live again and fails only if the call ends or does not reconnect in time. A quick mute then unmute during the swap now ends unmuted, instead of the unmute failing.
