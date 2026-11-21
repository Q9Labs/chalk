# Capture exclusion results

The independent feasibility probe established browser monitor capture exclusion with the platform settings below. This is not a real Chalk call or a measurement of the Helper's end-to-end latency.

| Operating system | Browser | Monitor capture |
| --- | --- | --- |
| macOS 26.6.2 | Helium (Chromium 158) | Zero marker pixels with `NSWindow.sharingType = .none`. |
| macOS 15.8.2 | Chrome 158 | Zero marker pixels with `NSWindow.sharingType = .none`. |
| Windows Server 2025 and 2022 | Chrome 157 | Zero marker pixels with `WDA_EXCLUDEFROMCAPTURE`. |
| macOS 27.0.1 | Chrome 157 | Screen Recording consent was unavailable. No track returned from the picker. |

The independent probe's unprotected controls showed 47,000–192,000 magenta pixels. Window and tab captures did not include the separate overlay. Safari, Firefox, and consumer Windows were not tested.

A second [hosted Windows test](https://github.com/Q9Labs/chalk/actions/runs/44919347699) captured a native marker over a 1024 × 768 monitor and decoded the result over WebRTC. Its six unprotected samples contained 24,888–25,000 marker pixels at 640-pixel analysis width. All six protected samples contained zero. That run did not report an alignment score because its PowerShell fixture did not record the expected marker position.

The monitor-only Chalk integration runs its own two-part check. It must see three landmarks at their expected positions in the local capture and then see them disappear after applying and reading back the platform setting. Failure leaves the browser preview path available. Real-call alignment, viewer-to-sharer overlay latency, and mixed-DPI projection are not yet verified.
