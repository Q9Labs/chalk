# Camera background proof

The [contact sheet](./contact-sheet.png) shows None, the real camera picker,
local and SFU-received Blur and Office, phone viewport controls, the slow-device
fallback message, and WebKit's camera picker without Background. The final row
compares the old chevron outline with keyboard focus on the entire split button.
Pointer clicks have no focus ring.

The subject is a fictional adult generated for this repository. The opaque
1280 × 720 image fills the camera frame without transparent padding. Its
[provenance](../../../apps/web/src/call-states/camera-fixtures/README.md) is
committed beside the fixture. The previous portrait and contact sheet have been
replaced.

## Runtime and browser proof

The [SFU report](./sfu-proof.json) records changed remote pixels for Blur and Office
through the browser SDK, local API and Sync, and an isolated development
Cloudflare SFU app. Switching None → Blur → Office → None retained the publication
ID, sender track, and receiver track. The sender reported hidden during each
switch, and the receiver continued decoding. The temporary SFU app was deleted.

`apps/web/tests/camera-backgrounds-proof.mjs` additionally drives the React picker
at 1440 × 900 and 390 × 844, verifies changed remote decoded pixels, camera
disabling, private-preview clones, hidden sender delivery, and app-origin
model/WASM requests. Preset requests use offline copies of Chalk's existing
assets in that test; the SFU test loads them from Chalk's asset host.

`apps/web/tests/camera-backgrounds-mobile.mjs` ran Playwright WebKit 26.5 and
Firefox 153 on Instabox at 390 × 844. Both lack the required track-processing
combination: Background, Blur, and Office were hidden, no effect assets loaded,
and the original camera track remained live and its preview advanced. Both had
zero page errors. This tests their supported behavior; it does not claim that
segmentation ran in these browsers.

Real Safari 27.0.1 on agents-macmini rejected session creation because “Allow
remote automation” is disabled. The setting was left unchanged; no sudo was
used. Not checked: real Safari rendering and physical low-end Android or iPhone
hardware, because those devices were not available. A narrow desktop viewport
and CPU throttling are not measurements of a physical phone. React Native is
outside this change.

## Slow-device guard

The processor allows one second of warm-up, then measures completed output
frames over three seconds of wall time, including segmentation and writer cost.
Below 15 fps it switches to plain camera frames, remembers None, and shows:
“Background off to keep video smooth.” It keeps the source and publication track
alive. Muted/disabled capture and effect changes reset the measurement. Selecting
an effect again clears the message and starts a new measurement.

The [mobile report](./mobile-proof.json) records an 8× Chromium CPU throttle on
Instabox (4 vCPU, software graphics), using a native 1280 × 720, 30 fps Y4M fake
camera. The native source avoids conflating a throttled JavaScript fixture timer
with slow processing. Blur completed **7.74 fps**, triggered fallback **6.08 s**
after selection including model loading, and the remote plain camera then
decoded **30.09 fps** during a two-second sample under the same throttle. The
publication and track were unchanged; the source stayed live and remote frames
continued. All page-error arrays were empty.

To reproduce, generate a native input with ffmpeg, start the call-state harness,
and run the proof:

```sh
ffmpeg -loop 1 -i apps/web/src/call-states/camera-fixtures/webcam-subject.jpg -t 1 -r 30 -pix_fmt yuv420p /tmp/chalk-camera-neutral.y4m
CAMERA_EFFECTS_FAKE_CAMERA=/tmp/chalk-camera-neutral.y4m node apps/web/tests/camera-backgrounds-mobile.mjs http://127.0.0.1:4481
```

Effects are capped at 24 fps and render at up to 960 pixels wide, or 640 in a
phone viewport. None uses the original camera dimensions with a 30 fps cap.
Physical-phone usability remains unverified; the runtime guard applies on every
supported device rather than assuming a viewport proves sufficient performance.

## Lazy loading and bundle cost

Joining with None made **zero** MediaPipe, model, or WASM requests. Selecting
Blur loaded the dynamically imported MediaPipe module and self-hosted runtime
and model; the report records those requests. Production initial-script
measurement also excludes the segmentation runtime. The React tarball contains
no WASM, model, or image files.

Matched frozen-lockfile builds compare production commit `2ec22c54` with this
branch on the same Instabox. Gzip uses level 9. The web figure is the scripts
actually requested on the production call route before Join; the SDK consumer
demo figure is its existing, unminified esbuild output. The [raw report](./bundle-cost.json)
includes the initial-script list. Neither build is a runtime-download total.

| Artifact                   | Before (bytes) | After (bytes) |  Added | Change |
| -------------------------- | -------------: | ------------: | -----: | -----: |
| Packed chalk-react tarball |        172,148 |       173,068 |    920 |  0.53% |
| Web initial JS, raw        |      1,586,329 |     1,598,424 | 12,095 |  0.76% |
| Web initial JS, gzip       |        474,750 |       478,906 |  4,156 |  0.88% |
| SDK demo initial JS, raw   |     18,659,096 |    18,685,866 | 26,770 |  0.14% |
| SDK demo initial JS, gzip  |      3,982,517 |     3,989,074 |  6,557 |  0.16% |

Reproduce with `turbo run build --filter=web... --concurrency=1`,
`pnpm --filter @chalk/sdk-web-consumer-e2e consumer:build`, and `pnpm pack` in
`sdks/typescript/react` at both revisions. Then pass the two repository roots,
two archives, and output path to `apps/web/tests/camera-backgrounds-bundle.mjs`.

## Dependency and remaining follow-ups

`@mediapipe/tasks-vision` is pinned to 1.1.1: Google's maintained segmentation
implementation, GPU support, Apache-2.0, about 22 million npm downloads in the
month checked, and no OSV advisories at the dependency check. Model and WASM are
hosted with the app. The six presets already existed on Chalk's asset host.
No frames go to a server for segmentation.

Remembered-effect asset-load recovery remains tracked in [#647](https://github.com/Q9Labs/chalk/issues/647).
Cancelled-load queue recovery and repeated-cleanup settings cases remain tracked
in [#649](https://github.com/Q9Labs/chalk/issues/649). Capture cancellation tests
require physical and generated tracks to stop immediately when leaving while a
remembered model load remains unresolved. The browser-only loader is exposed
through `@q9labsai/chalk-client/camera-effects`.
