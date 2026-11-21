import type { ScreenAnnotationDraft, ScreenAnnotationPoint, ScreenAnnotationTarget } from "@q9labsai/chalk-client";
import { simplifyStroke, type AnnotationRect } from "@q9labsai/chalk-screen-annotation";
import type { AnnotationBrush } from "./model";

type DrawingTool = Exclude<AnnotationBrush["tool"], "text" | "eraser" | "pointer">;

export type Gesture = {
  readonly pointerId: number;
  readonly target: ScreenAnnotationTarget;
  readonly rect: AnnotationRect;
  readonly clip: AnnotationRect;
  readonly style: Omit<ScreenAnnotationDraft, "shape">;
  readonly tool: DrawingTool;
  readonly stamp: AnnotationBrush["stamp"];
  points: readonly [ScreenAnnotationPoint, ...ScreenAnnotationPoint[]];
};

export function addGesturePoint(gesture: Gesture, point: ScreenAnnotationPoint): void {
  const last = gesture.points.at(-1);
  if (last?.x === point.x && last.y === point.y) return;
  if (gesture.tool !== "pen" && gesture.tool !== "highlighter") {
    gesture.points = [gesture.points[0], point];
    return;
  }
  const points = gesture.points.length >= 384 ? simplifyStroke(gesture.points) : gesture.points;
  gesture.points = [gesture.points[0], ...points.slice(1, 383), point];
}

export function gestureDraft(gesture: Gesture): ScreenAnnotationDraft {
  const { tool, points, style } = gesture;
  const first = points[0];
  if (tool === "stamp") return { ...style, shape: { kind: tool, at: first, stamp: gesture.stamp } };
  if (tool === "pen" || tool === "highlighter") {
    const simplified = simplifyStroke(points);
    const path = simplified.length > 1 ? simplified : [first, first];
    return { ...style, shape: { kind: tool, points: path } };
  }
  return { ...style, shape: { kind: tool, from_point: first, to_point: points.at(-1) ?? first } };
}

/** Input is in CSS pixels in the canvas viewport, even when stage zoom scales that viewport. */
export function localPoint(bounds: DOMRect, viewport: AnnotationRect, event: Pick<PointerEvent, "clientX" | "clientY">): ScreenAnnotationPoint {
  return {
    x: ((event.clientX - bounds.left) * viewport.width) / bounds.width,
    y: ((event.clientY - bounds.top) * viewport.height) / bounds.height,
  };
}

export function clampPoint(rect: AnnotationRect, point: ScreenAnnotationPoint): ScreenAnnotationPoint {
  return {
    x: Math.max(rect.x, Math.min(rect.x + rect.width, point.x)),
    y: Math.max(rect.y, Math.min(rect.y + rect.height, point.y)),
  };
}

export function sameRect(a: AnnotationRect, b: AnnotationRect): boolean {
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}
