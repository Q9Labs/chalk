export { FRAME_UNITS, clampedFramePoint, containsPoint, contentRect, framePoint, intersectRects, projectFramePoint, simplifyStroke } from "./geometry";
export type { AnnotationFit, AnnotationPoint, AnnotationRect } from "./geometry";
export { ANNOTATION_FONT_FAMILY, HIGHLIGHTER_OPACITY, NOTE_COLOR, NOTE_OPACITY, annotationMarkOpacity, compareAnnotationMarks, layoutAnnotationText, projectAnnotationMark } from "./mark-geometry";
export type { AnnotationMarkGeometry, AnnotationTextMeasure } from "./mark-geometry";
export { createAnnotationPresenceTracker, LASER_TRAIL_MS } from "./presence";
export type { AnnotationLaserSample, AnnotationPresence } from "./presence";
export { annotationFont, canvasAnnotationTextMeasure, type AnnotationCanvasContext } from "./canvas";
export { paintAnnotation, type PaintAnnotationOptions } from "./paint";
export { hitTestAnnotation } from "./hit-test";
export type { HitTestAnnotationOptions } from "./hit-test";
export { freezeAnnotationFrame } from "./frame";
export type { FreezeAnnotationFrameInput, ScreenAnnotationActions, ScreenAnnotationFrame } from "./frame";
export { captureAnnotationVideoFrame, encodeAnnotationCanvasPng, encodeAnnotationPng, renderAnnotationPng } from "./png";
export type { AnnotationPngSurface } from "./png";

export { INK_PROOF_TIMEOUT_MS, frameContainsStroke, frameProvesStroke, inkHandoff, makeBakedStrokeProof, makeStrokeProof, type BakedStrokeProof, type InkRaster, type StrokeProof } from "./baked-stroke-proof";
export { BakedExportProof } from "./baked-export";
