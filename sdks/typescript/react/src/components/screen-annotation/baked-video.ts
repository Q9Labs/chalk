import { paintAnnotation } from "@q9labsai/chalk-screen-annotation";
import type { ScreenAnnotationDraft } from "@q9labsai/chalk-client";
import { makeStrokeProof, type InkRaster } from "./baked-stroke-proof";

/** Keeps the exact sampled video frame until the next presentation callback. */
export function createBakedVideoSurface(document: Document) {
  const frame = document.createElement("canvas");
  const reader = document.createElement("canvas");
  const stencil = document.createElement("canvas");
  const frameContext = frame.getContext("2d", { alpha: false });
  const readerContext = reader.getContext("2d", { alpha: false, willReadFrequently: true });
  const stencilContext = stencil.getContext("2d", { willReadFrequently: true });
  if (!frameContext || !readerContext || !stencilContext) return null;
  let snapshot: InkRaster | null = null;
  let ready = false;

  function read(context: CanvasRenderingContext2D): InkRaster {
    const { width, height } = context.canvas;
    return context.getImageData(0, 0, width, height);
  }

  function pixels(): InkRaster | null {
    if (!ready) return null;
    if (!snapshot) {
      const scale = Math.min(800 / frame.width, 1200 / frame.height, 1);
      const width = Math.max(1, Math.round(frame.width * scale));
      const height = Math.max(1, Math.round(frame.height * scale));
      if (reader.width !== width) reader.width = width;
      if (reader.height !== height) reader.height = height;
      readerContext?.drawImage(frame, 0, 0, width, height);
      snapshot = readerContext && read(readerContext);
    }
    return snapshot;
  }

  return {
    image: () => (ready ? frame : null),
    capture(video: HTMLVideoElement) {
      if (frame.width !== video.videoWidth) frame.width = video.videoWidth;
      if (frame.height !== video.videoHeight) frame.height = video.videoHeight;
      frameContext.drawImage(video, 0, 0);
      ready = true;
      snapshot = null;
    },
    pixels,
    baselineFor(draft: ScreenAnnotationDraft) {
      const base = pixels();
      if (!base) return null;
      const { width, height } = base;
      stencil.width = width;
      stencil.height = height;
      const rect = { x: 0, y: 0, width, height };
      if (!stencilContext) return null;
      paintAnnotation(stencilContext, {
        rect,
        nowMs: 0,
        marks: [],
        presence: [{ server_at_ms: 0, expires_at_ms: 1, author: { participant_id: "local", display_name: "", color: draft.color }, cursor: null, draft }],
      });
      return makeStrokeProof(base, read(stencilContext));
    },
  };
}
