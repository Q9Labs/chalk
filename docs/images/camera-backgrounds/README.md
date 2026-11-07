# Camera background proof

The [contact sheet](./contact-sheet.png) shows None, the real camera picker,
local and SFU-received Blur and Office, phone viewport controls, the slow-device
fallback message, and WebKit's camera picker without Background. The final row
compares the old full-width row outline with keyboard focus on the content-sized
split button. The group measures 96 px at phone width, equal to its two buttons.
Mouse and touch clicks have no focus ring.

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

Tested WebKit has WebGL2 and VideoFrame, but lacks window-level
MediaStreamTrackProcessor and MediaStreamTrackGenerator. The current adapter
therefore keeps plain camera in Safari and other WebKit-based iPhone browsers.
Supporting browsers with the standard worker APIs needs a worker-based
MediaStreamTrackProcessor/VideoTrackGenerator adapter and real-device validation;
where those APIs are absent, an alternative capture pipeline is required.

Real Safari 27.0.1 on agents-macmini rejected session creation because “Allow
remote automation” is disabled. The setting was left unchanged; no sudo was
used. Not checked: real Safari rendering and physical low-end Android or iPhone
hardware, because those devices were not available. A narrow desktop viewport
and CPU throttling are not measurements of a physical phone. React Native is
outside this change.

## Browser proof failures

The previous proof waited for eight frames and screenshots before comparing
Blur pixels. On a slow runner the 15 fps guard could restore None before that
comparison, so correct fallback failed the test. A controlled run pinned the
browser to one CPU alongside two CPU load processes: the old proof failed with
None selected and a measured fallback rate of 1.23 fps.

The proof now observes the first decoded processed pixels while the requested
background is selected. Office must differ from both the plain camera and Blur;
the pixel-difference threshold remains 12. The revised proof passed at both
1440 × 900 and 390 × 844 under the same controlled load. No retries or guard
bypasses were added. Child-process stdout, stderr, and Xvfb diagnostics are
retained on failure.

The hosted failure at `38d29c4` happened before the proof started. Ubuntu 24.04's
`xvfb-run` cannot open `/dev/stderr` when Node supplies stderr as a socket. Debian
13's newer launcher special-cases that path, which explains why the previous
Instabox run missed it. The test now uses an owned temporary regular log file,
prints it on failure, and removes it during cleanup.

The Ubuntu launcher from `xvfb_21.1.12-1ubuntu1.9_amd64.deb` reproduced the exact
hosted errors at lines 159 and 82: the old invocation exited 2 without starting
its child; the fixed invocation exited 0 and started it. Its SHA-256 was
`48ee444c30fdaaede4cc311644b30e554162e956f949b206858e37eb8ba1ae05`.
The first hosted failure at `1e9f0a4` did not capture enough subprocess output
to prove its CI cause; that run retained leak reports but no browser artifacts.
The controlled timing race above is a separate, reproduced finding, rather
than an assertion about that missing log.

The full hosted browser command is:

```sh
CI=true GATE_LANE_GROUP=browser-tests GATE_SERVICES=external GATE_BASE_REF=origin/master GATE_WORKSPACE_CONCURRENCY=2 VITEST_MAX_WORKERS=2 pnpm exec bash scripts/gates/commit.sh --base origin/master
```

The full hosted command passed three consecutive times before push on the same
unchanged code revision `b65d8498`: 1: 14m21s, 2: 13m44s, 3: 13m37s. Each run
passed both selected lanes, browser-tests and dashboard-engine, with two workers
and Ubuntu 24.04's Xvfb launcher on Debian 13. The
[browser run report](./browser-run-proof.json) records the command, environment,
launcher version, and lane durations. No retries were added.

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
with slow processing. Blur completed **7.15 fps**, triggered fallback **6.29 s**
after selection including model loading, and the remote plain camera then
decoded **29.35 fps** during a two-second sample under the same throttle. The
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

Matched frozen-lockfile builds compare latest master `dee8a8fe` with code
`b65d8498` on the same Instabox. Gzip uses level 9. The web figure is the scripts
actually requested on the production call route before Join; the SDK consumer
demo figure is its existing, unminified esbuild output. The [raw report](./bundle-cost.json)
includes the initial-script list. Neither build is a runtime-download total.

| Artifact                   | Before (bytes) | After (bytes) |  Added | Change |
| -------------------------- | -------------: | ------------: | -----: | -----: |
| Packed chalk-react tarball |        173,069 |       174,158 |  1,089 |  0.63% |
| Web initial JS, raw        |      1,597,514 |     1,604,451 |  6,937 |  0.43% |
| Web initial JS, gzip       |        477,801 |       480,102 |  2,301 |  0.48% |
| SDK demo initial JS, raw   |     18,682,195 |    18,708,904 | 26,709 |  0.14% |
| SDK demo initial JS, gzip  |      3,987,696 |     3,994,714 |  7,018 |  0.18% |

The earlier “+920” React tarball figure meant **bytes**, not KB. The current
matched tarballs add **1,089 bytes**; package archives exclude dependencies.

The hosted call-performance failure at `38d29c4` was the production route’s
initial JS budget: **470.6 KiB gzip against 469 KiB**. Latest master passes at
**466.60 KiB**; the revised branch passes at **468.85 KiB** without changing
any budget. Frame processing loads at capture, and the provider and MediaPipe
load after choosing an effect. Camera state and preset data retain their
existing initial chunk instead of creating small shared chunks. Five
alternating route loads per revision had the same byte counts and zero
errors; these are byte measurements, not a CPU or render-time speedup. The
[performance report](./performance-proof.json) records both revisions and all
samples.

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
