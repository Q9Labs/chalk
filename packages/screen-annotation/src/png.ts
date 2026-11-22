import type { ScreenAnnotationFrameSize } from "@q9labsai/chalk-client";

import { freezeAnnotationFrame, type FreezeAnnotationFrameInput, type ScreenAnnotationFrame } from "./frame";
import { paintAnnotation, type AnnotationCanvasContext } from "./paint";

export type AnnotationPngSurface<Image, Png> = {
  readonly context: AnnotationCanvasContext;
  drawFrame(image: Image): void;
  encodePng(): Promise<Png>;
};

export async function renderAnnotationPng<Image, Png>(frame: ScreenAnnotationFrame<Image>, createSurface: (size: ScreenAnnotationFrameSize) => AnnotationPngSurface<Image, Png>): Promise<Png> {
  const surface = createSurface(frame.size);
  surface.drawFrame(frame.image);
  paintAnnotation(surface.context, { rect: { x: 0, y: 0, ...frame.size }, marks: frame.marks, nowMs: frame.nowMs });
  return surface.encodePng();
}

/** The stage must first check that the playing video still belongs to the matched publication. */
export function captureAnnotationVideoFrame(video: HTMLVideoElement, snapshot: Omit<FreezeAnnotationFrameInput<HTMLCanvasElement>, "image" | "size">, sampledFrame?: HTMLCanvasElement | null): ScreenAnnotationFrame<HTMLCanvasElement> {
  const size = { width: sampledFrame?.width ?? video.videoWidth, height: sampledFrame?.height ?? video.videoHeight };
  if (video.readyState < video.HAVE_CURRENT_DATA || size.width <= 0 || size.height <= 0) throw new Error("No current video frame");
  const image = video.ownerDocument.createElement("canvas");
  image.width = size.width;
  image.height = size.height;
  const context = image.getContext("2d");
  if (!context) throw new Error("Canvas 2D is unavailable");
  context.drawImage(sampledFrame ?? video, 0, 0, size.width, size.height);
  return freezeAnnotationFrame({ ...snapshot, image, size });
}

export function encodeAnnotationPng(frame: ScreenAnnotationFrame<CanvasImageSource>, ownerDocument: Document = document): Promise<Blob> {
  return renderAnnotationPng(frame, (size) => {
    const canvas = ownerDocument.createElement("canvas");
    canvas.width = size.width;
    canvas.height = size.height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Canvas 2D is unavailable");
    return {
      context,
      drawFrame: (image) => context.drawImage(image, 0, 0, size.width, size.height),
      encodePng: () => encodeAnnotationCanvasPng(canvas),
    };
  });
}

/** Encode the captured canvas itself to upload the pristine frame, without drawing ink onto it. */
export function encodeAnnotationCanvasPng(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error("Could not encode annotation frame"));
    }, "image/png");
  });
}
