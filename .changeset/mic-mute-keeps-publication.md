---
"@q9labsai/chalk-client": patch
---

Keep the microphone publication when a participant mutes. Mute now sends silence on the existing sender and releases the capture device, so unmute is a local track swap with no new publication for listeners to pull. This fixes unmute sometimes staying inaudible until the next toggle or rejoin. A muted participant's provider track stays open and carries silence while Sync reports the microphone as off; host mute still closes the publication.
