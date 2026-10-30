# Camera Backgrounds Prompt

We need to implement Chalk camera background effects.

Goal: add a provider-neutral client-side camera effects layer that can produce a processed MediaStreamTrack for local preview and SFU publication. We don't want to send raw camera frames to a Chalk server for live processing.

## Browser integration

Before creating a browser Space client, configure assets hosted by your app:

```ts
import { configureCameraEffects } from "@q9labsai/chalk-client/camera-effects";

configureCameraEffects({
  wasmRoot: "/camera-effects/tasks-vision-1.1.1/",
  modelUrl: "/camera-effects/selfie-segmenter-landscape.tflite",
});
```

Copy the `wasm/` directory from the pinned `@mediapipe/tasks-vision@1.1.1`
dependency to `wasmRoot`. Host the MediaPipe `selfie_segmenter_landscape`,
float16, version 1 model at `modelUrl`. Both use Apache-2.0; retain its license.
Use versioned or content-hashed URLs when serving immutable cached files.
The Chalk web app does this in `sync:public` and includes its model in `public/`.
The SDK packages contain metadata and code, not the WASM, model, or image binaries.

The React camera menu offers None, Blur, and six existing Chalk presets when
configured browser capture supports WebGL2 and insertable video streams
(`MediaStreamTrackProcessor`, `MediaStreamTrackGenerator`, and `VideoFrame`). Unconfigured or unsupported browsers keep ordinary camera capture and
hide the picker. React Native is outside this change.

Capture produces one generated video track shared by preview and publication.
Captured frames drive the processor, including while the call tab is hidden;
it does not depend on document rendering callbacks. Changing an
effect changes the canvas contents without replacing the sender or renegotiating
the publication. None preserves the camera dimensions and runs at up to 30 fps.
Active effects run at up to 24 fps, with a maximum width of 960 pixels, or 640 in
phone-sized viewports. The segmentation model runs entirely in the browser.
No video frames are uploaded for processing. Preset images come from Chalk's
asset host, with AVIF preferred and WebP as fallback.

Choices are stored per camera device ID in local storage, with an in-memory
fallback when storage is blocked. A failed load leaves the previous effect
selected. Loading a remembered effect fails capture rather than sending an
unprocessed camera; a processing failure ends the output track so normal camera
recovery can take over. Stopping the output releases the camera, model, frame reader, and frame writer. Camera disabling, interruptions, and private preview clones retain
their capture semantics.

For a custom capture integration, `processCameraStream(stream)` applies the same
configured, per-device effects. `createCameraEffectsTrack(source, assets)` exposes
the provider-neutral processor directly; call `prepare(background)` and then the
returned commit function before using its output track. Stop its output when done. Import the ready-made
MediaPipe processor from `@q9labsai/chalk-client/camera-effects`; the root entry
also exposes `configureCameraEffectProvider` and a processor factory seam for
other client-side segmentation providers. Native entry points do not import
the browser segmentation runtime. Leaving or disposing capture aborts pending
effect initialization and immediately releases the physical camera.

## Verification

Unit tests cover device preferences, load failures, capture ownership, late model
loads, camera disabling, interruptions, and private previews. The web
`apps/web/src/call-states/camera-backgrounds.test.ts` proof drives the real picker and sends the processed
track between two real WebRTC peers. On Linux it uses a headed browser under
Xvfb, removes Playwright's focus override, and requires remote frames while the
sender document reports hidden. It checks decoded remote background pixels
and stable sender, track, and publication identities. It also saves screenshots
and a frame-rate sample for None, Blur, and Office at laptop and phone viewport
sizes. Set `CAMERA_EFFECTS_MEASURE=1` for five alternating samples per option and
`CAMERA_EFFECTS_PROOF_DIR` to retain the artifacts. The development-only
`scripts/dev/camera-backgrounds-sfu-proof.mjs` additionally verifies the full SDK
publication path against an isolated development SFU application; provide its
private credential file as described in the script, outside version control,
and run the script under `xvfb-run -a` on Linux.
