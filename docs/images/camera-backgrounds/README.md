# Camera background proof

The [contact sheet](./contact-sheet.png) pairs the existing camera menu with the
new picker, local processed previews, and video received through the development
SFU. It also includes a 390 × 844 browser viewport. The source is a synthetic, animated camera using the MediaPipe portrait fixture: 1280 × 720 for laptop measurements and 640 × 360 for Instabox transport proof.

## Runtime proof

The [SFU report](./sfu-proof.json) records successful remote pixel changes for
Blur and Office through the actual browser SDK, local API and Sync services, and
an isolated development Cloudflare SFU app. Switching None → Blur → Office → None
retained the remote publication ID, the sender track, and the receiver track.
The sending document reported hidden during each switch; the receiver continued
decoding new frames for Blur, Office, and None. The temporary SFU app was removed after the check.

The automated browser test additionally drives the real React picker at both
viewport sizes, checks remote decoded pixels, checks native camera disabling, private-preview clone behavior, and
continued delivery while the sender is hidden, and requires model/WASM requests to use the app
origin. It routes preset image requests to offline copies of Chalk's existing
assets. The separate SFU run loads those images from Chalk's asset host.

## Frame rates

These are observed local preview frame rates in Helium 156 on an Apple M4 laptop
with 16 GB RAM and 10 CPU cores. Five alternating 1.5-second samples per option,
after at least eight advancing frames of warm-up. The machine's initial load
average was 1.98 across ten cores. The [raw samples](./laptop-fps.json) include
all thirty measurements and zero browser errors.

| Viewport   | None, median (range) | Blur, median (range) | Office, median (range) |
| ---------- | -------------------- | -------------------- | ---------------------- |
| 1440 × 900 | 30.0 (29.3–30.7) fps | 23.3 (23.1–24.0) fps | 23.9 (23.2–24.0) fps   |
| 390 × 844  | 29.9 (29.3–30.7) fps | 24.0 (23.1–24.0) fps | 24.0 (23.2–24.0) fps   |

None is capped at 30 fps. Effects are capped at 24 fps and render at up to 960
pixels wide, or 640 in the phone viewport. The effect results are close to that
configured cap; this is a usability check, not a claim that an effect is faster
than another. The source, preview, and browser scheduling also limit
observed FPS. Decoded local frames and changed pixels establish that the work
actually ran. Instabox uses software graphics, so its remote-video FPS is used
only to check continued delivery, not as a laptop performance result.

Not checked: physical phone hardware, Safari, and Firefox. The phone result is
a narrow browser viewport on the same M4. The laptop's local WebRTC loopback did
not connect, so remote delivery was verified separately on Instabox and through
the development SFU. React Native is outside this change.

## Dependency

`@mediapipe/tasks-vision` is pinned to 1.1.1. It supplies Google's maintained
segmentation implementation, supports GPU processing, and uses Apache-2.0.
At the dependency check it had about 22 million npm downloads in the preceding
month; OSV reported no advisories for 1.1.1. That version had been available for
over two weeks; the newer 1.2.0 release was only three days old. The model and WASM
are hosted with the app, and the six presets already existed on Chalk's asset
host. No video frames go to a server for segmentation.

A saved effect whose assets fail to initialize currently fails camera capture
closed. Clearing that stored choice from the picker is tracked in
[follow-up #647](https://github.com/Q9Labs/chalk/issues/647).
