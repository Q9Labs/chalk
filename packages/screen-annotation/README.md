# Chalk screen annotation renderer

Use this package to draw the same annotation scene over a screen share, a detached overlay, or a recording frame. The SDK owns the scene and its clock. The renderer does not open sockets, load images, or mutate the scene.

## Geometry and paint

- Call `contentRect(intrinsicSize, viewport, "fit" | "fill")` when the measured viewport or decoded aspect changes. Use one coordinate space for the viewport, input and Canvas context. Apply device scale to the Canvas backing buffer separately.
- On gesture start, reject points outside the viewport or `framePoint(rect, point)` returning null. Use `clampedFramePoint` for an active drag that leaves the frame. `simplifyStroke` produces at most 384 points for a wire draft.
- Call `paintAnnotation(ctx, { rect, clip, marks, presence, sharerId, paused, nowMs })` with the visible viewport as `clip` and time on the Sync clock. The caller clears its overlay or draws the decoded frame before this call. With no context transform, rect and clip are in backing pixels.
- Use one `createAnnotationPresenceTracker()` per live layer. Give it each complete current presence list as it arrives, and pass its output to the renderer. Call `clear()` on recovery or detachment. Repaint while a fade or trail is active even if the SDK sends no update.
- Use `hitTestAnnotation(point, { rect, clip, marks, nowMs, paused, sharerId, measureText, canErase })` to pick the topmost visible accepted mark. Use `canvasAnnotationTextMeasure(ctx)` for the same text layout as paint. Apply permissions at the SDK boundary; a local hit is not permission to erase.

Load the package's `fonts/Figtree-SemiBold.ttf` as weight 600 under the exported `ANNOTATION_FONT_FAMILY` before painting. Register those same bytes with the Canvas font registry in a headless renderer. Stamps use paths, not font glyphs.

## Frozen actions

On an explicit action, use `captureAnnotationVideoFrame(video, snapshot)` for DOM playback, or capture an image with the native adapter and pass it to `freezeAnnotationFrame`. Check that the source belongs to the active publication before capture. Keep the captured image unchanged until the action finishes. Expiry and pause visibility stay frozen at the action time.

`encodeAnnotationPng` returns a browser PNG Blob at the frame's intrinsic dimensions. `renderAnnotationPng` lets other Canvas hosts supply the frame draw and encoder. Both draw accepted marks only.

`@q9labsai/chalk-whiteboard/annotation` supplies `annotationWhiteboardPlacement` and `createAnnotationWhiteboardImport`. Give the import a board-scoped upload adapter and the active board's SDK transport. The adapter uploads only the pristine frame and must accept a retry with the same file ID and bytes. In a browser, use `encodeAnnotationCanvasPng` for these unmarked bytes. Retry via the returned object's `save()`; creating another object starts a new insertion.
