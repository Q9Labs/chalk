# Capture exclusion results

No desktop capture mode is approved for native ink. These probes did not establish a clean outgoing track.

| OS | Browser or capture path | Monitor capture | Window capture | Tab capture |
| --- | --- | --- | --- | --- |
| macOS 27.0.1 | Chrome 157.0.8103.80 | Picker did not return a track | Picker did not return a track | Picker did not return a track |
| macOS 27.0.1 | Safari 27.0.1 | Not run | Not run | Not run |
| macOS 27.0.1 | Edge | Not installed on the probe Mac | Not run | Not run |
| macOS 27.0.1 | Firefox | Not installed on the probe Mac | Not run | Not run |
| macOS 27.0.1 | ScreenCaptureKit filtered capture | Screen Recording consent was unavailable | Not applicable | Not applicable |
| Windows | Browser with `WDA_EXCLUDEFROMCAPTURE` marker | No runner | No runner | No runner |

The Chrome trials used the shipping browser and a native click-through marker. The picker did not complete even with the unprotected marker, so there is no positive control. The local Mac session did not have Screen Recording consent. The native UI automation service did not start. The Windows box provider rejected the configured free mode before creating a box.

The ScreenCaptureKit and local WebRTC probe sources build on arm64 macOS. A synthetic VP8 run established ICE and DTLS with Chrome in the local loopback test profile. See the development instructions for the separate real-display proof. A connected peer without decoded frames does not pass the handoff or capture exclusion checks.

Keep all live Helper overlays disabled. A working browser-only path remains the in-call preview or Document Picture-in-Picture, where available.
