# Screen annotation proof

Use a fresh test Episode with a test sharer, a drawing viewer, and an observing viewer. Keep the capture, decoded frames, telemetry, and JSON under `.verify/` and out of Git. Install the workspace dependencies and make `ffmpeg` and `ffprobe` available.

## Recording export

Run from the repository root. The output directory must not exist.

```sh
pnpm --dir apps/recording-renderer build
pnpm --dir apps/recording-renderer exec vite build --config vite.node.config.ts --mode fixture
node scripts/ui-check/screen-annotation/recording.mjs .verify/screen-annotation-recording
```

The proof runs the release compositor on generated VP8 media. It compares the no-sidecar and empty-sidecar exports, checks the annotated frame against the clean crosshairs, and verifies an exact frame before and after the late checkpoint, change, pause, resume, clear, publication replacement and sidecar close. It tests a recording-time fade, clipping at a letterboxed edge, duplicate revision delivery, and failure on a mismatched recording ID. Open `clean-frame.png`, `sample-frame.png` and `proof.json` from the output directory.

The test binds the sidecar by SHA-256. In an integrated run, the recording worker must stage a sidecar from the same authorized, frozen attempt input as presentation and media. The compositor accepts an absolute workspace-confined `--annotation-sidecar` and `--annotation-sha256`; the Go worker exposes these as `FrameRenderRequest.AnnotationSidecar`. The reader's v1 envelope is `{version, recordingId, episodeId, originAuthorityId, captureEpoch, layers: [{sourceIds, sidecar}]}`, where `sidecar` is the layer timeline in the [plan](../../../docs/plans/screen-annotation.md#recordings). Each source ID is an authenticated recording-presentation source ID for that publication, not a provider track name or a participant ID. Resolve publication-to-source identity at capture/freeze. A checkpoint at capture start may contain a kept mark with a negative relative commit time. Omit an absent sidecar; do not omit a sidecar that is present but fails validation.

## Cross-surface measurement

Generate the share source. Open it in the surface being captured. Resize or rotate the capture origin, not a screenshot of it.

```sh
node scripts/ui-check/screen-annotation/measure.mjs fixture .verify/annotation/capture.html
```

Use the web and mobile TesterArmy journeys and the native capture rigs to collect the bundle below. The collector must use the real input and rendered surfaces. A canvas unit test, a Sync receipt, a simulated native overlay, or a local paint-submission hook cannot substitute for presented pixels. The fixture and evaluator are runnable now; capture adapters need the integrated web, native overlay, mobile and Sync lanes.

1. For alignment, start with a clean frame. Put a symmetric magenta (`#ff00ff`) mark on each visible orange cross. Save clean and marked frames in their native pixel dimensions. For the exported frame, pick its frame number after commit. The uncertainty of a screen capture or a downscaled recording counts toward the measured error.
2. Cover portrait, landscape, contain and cropped fill; resize and scroll; tab, window and monitor capture; mixed-DPI monitors with a negative origin; and Android rotation and insets. If the OS cannot map a target, record an unmapped attempt with its cause. Do not supply a zero-error sample. For fill, use the width of the full mapped content before it is clipped.
3. For latency, send at least 100 non-overlapping marks in each controlled RTT/jitter/loss scenario. Repeat on real web and mobile endpoints. On two machines, calibrate the monotonic clocks against one another and record the receiver-minus-sender offset and uncertainty. Pair each input with the first frame that actually presents its preview and then its committed mark. Use synchronized video or a verified presentation callback. Record a missing preview or commit as `null`. A Sync receipt is not a paint.
4. For exclusion, disable in-call mark painting on the **raw video sampling instrument**, not on the observed call UI. Save the native overlay showing the mark as a positive control. Capture the same static fiducial in the pristine outgoing media and the remote raw track immediately before and while the native overlay draws. Neither video should contain the magenta ink.

Write a JSON bundle next to its evidence files. File bindings use paths relative to the bundle and optionally a zero-based `frame` in a video (default 0). Pixel regions are `{x, y, width, height}` in the evidence image, not CSS pixels. Choose regions around the corresponding cross that exclude unrelated orange or magenta content.

| Bundle field (`version: 1`) | Required data                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `alignment[]`               | `id`, `surface` (`remote`, `sharer_overlay`, `export`), `tags` (capture conditions listed below), and `samples`. Mapped samples have `mapping: "mapped"`, `reference` (clean image binding), `frame` (marked image binding), `region`, and `displayedFrameWidthPx`. Unmapped samples have `mapping: "unmapped"` and `cause`.                                                                                                                                 |
| `latency[]`                 | `id`, `surface` (`remote` or `sharer_overlay`), `environment` (`controlled`, `real_web`, `real_mobile`), `network: {rttMs, jitterMs, lossPercent}`, `frameRate`, `presentation` (`synchronized_video` or `frame_callback`), `clock: {domain, receiverMinusSenderMs, uncertaintyMs}`, and `samples: [{id, pointerMs, releaseMs, previewPresentedMs, committedPresentedMs}]`. Use `same_monotonic_clock` with offset zero, or `synchronized_monotonic_clocks`. |
| `exclusion[]`               | `id`, `platform` (`macos`, `windows` or `android`), `overlay: {frame, region}` (the frame binding is a positive control), and `outgoing` and `remote` each with `{before, during, region}`.                                                                                                                                                                                                                                                                  |

Use the alignment tags `portrait`, `landscape`, `contain`, `cover`, `resize`, `scroll`, `tab`, `window`, `monitor`, `mixed_dpi_negative_origin`, and `android_rotation_insets`.

```sh
node scripts/ui-check/screen-annotation/measure.mjs measure .verify/annotation/bundle.json
```

The report gives nearest-rank p95 Euclidean alignment error divided by mapped frame width per surface and scenario (target below 0.005), and p50/p95 plus missing-paint counts for preview and commit separately. The preview p95 plus clock uncertainty is compared to 150 ms viewer to viewer and 200 ms viewer to native overlay. The report lists unmeasured coverage separately. In the actual journeys, also exercise draw allow and deny, request approval, draft visibility, fade, redo, pause and clear racing a pending stroke, capture replacement, reconnect, PNG and editable whiteboard save. Capture the matching real export. Check Android permission deny/revoke and native detach; collect macOS and Windows signed Helper attachment and cleanup evidence.

## Journey ledger and trace redaction

In a new test Episode, try to bind as an unauthorized viewer, bind as the active sharer, send the same bind again, attempt a denied write, and end the Episode while the layer is live. Collect the actual response and the latest visible layer revision after each step. Set a known valid trace ID for the accepted open. Record the expected trace on closure: the producer uses the Episode-end operation's trace when available, otherwise the opening trace. Collect the parent screen publication event ID, or the Episode event ID if it has no publication journey. Exercise one accepted native bridge attach and one refused attach.

Write `probe.json` with:

- `version: 1`, `journeyId`, `episodeId`, `parentEventId`, `publicationId`, `layerId`, and `traceIds: {open, close}`.
- `observations`: `bind` and `retryBind` with `{result: "accepted", layerId, revision}` from the live replies; `deniedBind: {result: "rejected", layerId: null}`; `deniedWrite: {result: "rejected", visibleRevision}` with the observed unchanged revision; and `episodeEnd: {layerId: null}` from the terminal state.
- `bridge`: both `{event, method, outcome, cause}` annotations, where `outcome` is `attached` or `rejected`. Match the values in the observed structured logs. A success may use a bounded cause such as `none`.
- `redaction: {canaries, logs}`: three distinctive synthetic test values given as mark text, an invalid attach credential and invalid trace context, and the relative paths to the JSONL telemetry files. Export a scoped slice that includes the bridge outcomes and trace/log rows from the test.

Use the local test database's `PG*` configuration, or pass a JSON export of its scoped ledger rows as the trailing argument. The proof reads only the named journey.

```sh
node scripts/ui-check/screen-annotation/ledger.mjs .verify/annotation/probe.json
```

The evaluator requires exactly one `screen_annotation.opened` and one `screen_annotation.closed` in the journey, a parent chain from closure to opening to the parent publication or Episode, the same share binding, the expected trace IDs with valid span IDs, Episode-end cause `episode_ended`, and no test credential, mark text or invalid trace context in the ledger or captured telemetry. If the integrated producer chooses a different bounded field or outcome, update the matcher alongside that contract; do not make redaction or correlation optional.
