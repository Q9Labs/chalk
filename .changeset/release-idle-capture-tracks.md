---
"@q9labsai/chalk-client": patch
"@q9labsai/chalk-react-native": patch
---

A muted microphone or camera now frees its capture 30 seconds after the mute, and Leave frees every local track. Before, a muted or left call kept its capture track open: on React Native `track.stop()` only marks a track ended in JavaScript, and only `release()` frees the native capture. Unmuting after the 30 seconds captures a fresh track. The microphone indicator can stay on for up to 30 seconds after a mute. Platform adapters now supply `mediaDevices.releaseTrack(track)`: the web stops the track, and React Native stops it and calls `release()`.
