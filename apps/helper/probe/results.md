# Capture exclusion results

The independent feasibility probe established browser monitor capture exclusion with the platform settings below. This is not a real Chalk call or a measurement of the Helper's end-to-end latency.

| Operating system | Browser | Monitor capture |
| --- | --- | --- |
| macOS 26.6.2 | Helium (Chromium 158) | Zero marker pixels with `NSWindow.sharingType = .none`. |
| macOS 15.8.2 | Chrome 158 | Zero marker pixels with `NSWindow.sharingType = .none`. |
| Windows Server 2025 and 2022 | Chrome 157 | Zero marker pixels with `WDA_EXCLUDEFROMCAPTURE`. |
| macOS 27.0.1 | Chrome 157 | Screen Recording consent was unavailable. No track returned from the picker. |

The independent probe's unprotected controls showed 47,000–192,000 magenta pixels. Window and tab captures did not include the separate overlay. Safari, Firefox, and consumer Windows were not tested.

A [hosted Windows Server 2025 run](https://github.com/Q9Labs/chalk/actions/runs/44920684852) passed the Rust tests and built the unsigned x64 NSIS installer. Headed Chrome selected the entire 1024 × 768 desktop and decoded the capture over WebRTC. At 640 pixels of analysis width, six unprotected samples contained 24,872–25,000 marker pixels; all six protected samples contained zero. The marker's measured p95 distance from its target center was 0.047% of frame width. This is alignment of the native test marker, not the Chalk overlay in a call.

The monitor-only Chalk integration runs its own two-part check. It must see three landmarks at their expected positions in the local capture and then see them disappear after applying and reading back the platform setting. Failure leaves the browser preview path available. Real-call alignment, viewer-to-sharer overlay latency, and mixed-DPI projection are not yet verified.
