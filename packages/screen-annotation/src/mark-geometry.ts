import type { ScreenAnnotationDraft, ScreenAnnotationMark } from "@q9labsai/chalk-client";

import { FRAME_UNITS, projectFramePoint, type AnnotationPoint, type AnnotationRect } from "./geometry";

export const ANNOTATION_FONT_FAMILY = "Chalk Annotation Figtree";
export const HIGHLIGHTER_OPACITY = 0.36;
export const NOTE_COLOR = "#0a0a0c";
export const NOTE_OPACITY = 0.82;
const FADE_MS = 600;

export type AnnotationTextMeasure = (text: string, size: number) => number;

export type AnnotationMarkGeometry = { readonly color: string; readonly width: number } & (
  | { readonly kind: "pen" | "highlighter"; readonly points: readonly AnnotationPoint[] }
  | { readonly kind: "line"; readonly from: AnnotationPoint; readonly to: AnnotationPoint }
  | { readonly kind: "arrow"; readonly from: AnnotationPoint; readonly to: AnnotationPoint; readonly head: readonly AnnotationPoint[] }
  | { readonly kind: "box" | "circle"; readonly bounds: AnnotationRect }
  | { readonly kind: "text"; readonly at: AnnotationPoint; readonly text: string; readonly fontSize: number; readonly note: boolean }
  | { readonly kind: "stamp"; readonly at: AnnotationPoint; readonly radius: number; readonly paths: readonly (readonly AnnotationPoint[])[] }
);

export function annotationMarkOpacity(mark: ScreenAnnotationMark, nowMs: number): number {
  if (nowMs < mark.committed_at_ms) return 0;
  if (mark.expires_at_ms === null) return 1;
  return Math.max(0, Math.min(1, (mark.expires_at_ms - nowMs) / FADE_MS));
}

export function compareAnnotationMarks(a: ScreenAnnotationMark, b: ScreenAnnotationMark): number {
  return a.created_revision - b.created_revision;
}

export function projectAnnotationMark(rect: AnnotationRect, draft: ScreenAnnotationDraft): AnnotationMarkGeometry {
  const { shape, color } = draft;
  const style = { color, width: (draft.width / FRAME_UNITS) * rect.width };
  switch (shape.kind) {
    case "pen":
    case "highlighter":
      return { ...style, kind: shape.kind, points: shape.points.map((point) => projectFramePoint(rect, point)) };
    case "line":
    case "arrow":
    case "box":
    case "circle": {
      const from = projectFramePoint(rect, shape.from_point);
      const to = projectFramePoint(rect, shape.to_point);
      if (shape.kind === "line") return { ...style, kind: "line", from, to };
      if (shape.kind === "arrow") return { ...style, kind: "arrow", from, to, head: arrowHead(from, to, style.width) };
      return {
        ...style,
        kind: shape.kind,
        bounds: { x: Math.min(from.x, to.x), y: Math.min(from.y, to.y), width: Math.abs(to.x - from.x), height: Math.abs(to.y - from.y) },
      };
    }
    case "text":
      return { ...style, kind: "text", at: projectFramePoint(rect, shape.at), text: shape.text, note: shape.note, fontSize: 7 * style.width };
    case "stamp": {
      const at = projectFramePoint(rect, shape.at);
      const radius = 7 * style.width;
      const paths = stampPaths[shape.stamp].map((path) => path.map(([x, y]) => ({ x: at.x + x * radius, y: at.y + y * radius })));
      return { ...style, kind: "stamp", at, radius, paths };
    }
  }
}

export function layoutAnnotationText(geometry: Extract<AnnotationMarkGeometry, { kind: "text" }>, measure: AnnotationTextMeasure) {
  const { at, fontSize, text } = geometry;
  const lines = text.split(/\r\n?|\n/);
  const lineHeight = fontSize * 1.25;
  const padding = fontSize * 0.35;
  const width = Math.max(...lines.map((line) => measure(line, fontSize)));
  const height = lines.length * lineHeight;
  return {
    lines,
    lineHeight,
    bounds: { x: at.x, y: at.y - lineHeight / 2, width, height },
    noteBounds: { x: at.x - padding, y: at.y - lineHeight / 2 - padding, width: width + 2 * padding, height: height + 2 * padding },
    radius: padding,
  };
}

function arrowHead(from: AnnotationPoint, to: AnnotationPoint, width: number): readonly AnnotationPoint[] {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const length = Math.hypot(dx, dy);
  if (length === 0) return [];
  const angle = Math.atan2(dy, dx);
  const size = Math.min(width * 5, length);
  return [to, { x: to.x - size * Math.cos(angle - 0.45), y: to.y - size * Math.sin(angle - 0.45) }, { x: to.x - size * Math.cos(angle + 0.45), y: to.y - size * Math.sin(angle + 0.45) }];
}

type StampPath = readonly (readonly [number, number])[];

// Paths use the same stamp radius on every Canvas implementation, independent of emoji fonts.
const stampPaths = {
  check: [
    [
      [-0.51, 0.01],
      [-0.16, 0.34],
      [0.5, -0.33],
    ],
  ],
  cross: [
    [
      [-0.37, -0.37],
      [0.37, 0.37],
    ],
    [
      [0.37, -0.37],
      [-0.37, 0.37],
    ],
  ],
  star: [
    [
      [0, -0.62],
      [0.15, -0.19],
      [0.6, -0.19],
      [0.24, 0.08],
      [0.37, 0.53],
      [0, 0.26],
      [-0.37, 0.53],
      [-0.24, 0.08],
      [-0.6, -0.19],
      [-0.15, -0.19],
      [0, -0.62],
    ],
  ],
  question: [
    [
      [-0.33, -0.27],
      [-0.26, -0.45],
      [-0.09, -0.54],
      [0.12, -0.54],
      [0.3, -0.41],
      [0.34, -0.24],
      [0.27, -0.1],
      [0.06, 0.05],
      [0, 0.17],
    ],
    [[0, 0.48]],
  ],
  heart: [
    [
      [0, -0.25],
      [-0.18, -0.44],
      [-0.37, -0.45],
      [-0.54, -0.31],
      [-0.57, -0.11],
      [-0.44, 0.14],
      [0, 0.53],
      [0.44, 0.14],
      [0.57, -0.11],
      [0.54, -0.31],
      [0.37, -0.45],
      [0.18, -0.44],
      [0, -0.25],
    ],
  ],
} satisfies Record<string, readonly StampPath[]>;
