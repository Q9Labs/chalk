import type { ScreenAnnotationMark } from "@q9labsai/chalk-client";

import { containsPoint, segmentDistanceSquared, type AnnotationPoint, type AnnotationRect } from "./geometry";
import { annotationMarkOpacity, compareAnnotationMarks, layoutAnnotationText, projectAnnotationMark, type AnnotationMarkGeometry, type AnnotationTextMeasure } from "./mark-geometry";
import type { PaintAnnotationOptions } from "./paint";

export type HitTestAnnotationOptions = Omit<PaintAnnotationOptions, "presence"> & {
  readonly measureText: AnnotationTextMeasure;
  /** Additional radius in the same units as rect, not backing canvas pixels. */
  readonly tolerance?: number;
  readonly canErase?: (mark: ScreenAnnotationMark) => boolean;
};

export function hitTestAnnotation(point: AnnotationPoint, { rect, clip = rect, marks, nowMs, paused, sharerId, measureText, tolerance = 4, canErase }: HitTestAnnotationOptions): ScreenAnnotationMark | null {
  if (!containsPoint(rect, point) || !containsPoint(clip, point)) return null;
  for (const mark of [...marks].sort(compareAnnotationMarks).reverse()) {
    if (paused && mark.author.participant_id !== sharerId) continue;
    if (annotationMarkOpacity(mark, nowMs) === 0 || (canErase && !canErase(mark))) continue;
    if (hitsGeometry(point, projectAnnotationMark(rect, mark.draft), Math.max(0, tolerance), measureText)) return mark;
  }
  return null;
}

function hitsGeometry(point: AnnotationPoint, geometry: AnnotationMarkGeometry, tolerance: number, measureText: AnnotationTextMeasure): boolean {
  const radius = geometry.width / 2 + tolerance;
  const maxSquared = radius ** 2;
  switch (geometry.kind) {
    case "pen":
    case "highlighter":
      return hitsPath(point, geometry.points, maxSquared);
    case "line":
      return segmentDistanceSquared(point, geometry.from, geometry.to) <= maxSquared;
    case "arrow":
      return hitsArrow(point, geometry, maxSquared, tolerance);
    case "box":
    case "circle":
      return hitsOutline(point, geometry, radius);
    case "text": {
      const text = layoutAnnotationText(geometry, measureText);
      return containsPoint(expand(geometry.note ? text.noteBounds : text.bounds, tolerance), point);
    }
    case "stamp":
      return Math.hypot(point.x - geometry.at.x, point.y - geometry.at.y) <= geometry.radius + radius;
  }
}

function hitsArrow(point: AnnotationPoint, geometry: Extract<AnnotationMarkGeometry, { kind: "arrow" }>, maxSquared: number, tolerance: number): boolean {
  if (segmentDistanceSquared(point, geometry.from, geometry.to) <= maxSquared) return true;
  const [tip, left, right] = geometry.head;
  if (!tip || !left || !right) return false;
  const edges = [
    [tip, left],
    [left, right],
    [right, tip],
  ] as const;
  const signs = edges.map(([from, to]) => (to.x - from.x) * (point.y - from.y) - (to.y - from.y) * (point.x - from.x));
  return signs.every((value) => value >= 0) || signs.every((value) => value <= 0) || edges.some(([from, to]) => segmentDistanceSquared(point, from, to) <= tolerance ** 2);
}

function hitsOutline(point: AnnotationPoint, geometry: Extract<AnnotationMarkGeometry, { kind: "box" | "circle" }>, radius: number): boolean {
  const { bounds } = geometry;
  if (!containsPoint(expand(bounds, radius), point)) return false;
  if (bounds.width === 0 || bounds.height === 0) {
    return segmentDistanceSquared(point, bounds, { x: bounds.x + bounds.width, y: bounds.y + bounds.height }) <= radius ** 2;
  }
  return geometry.kind === "box" ? roundedOutlineDistance(point, bounds, geometry.width * 2) <= radius : ellipseDistance(point, bounds) <= radius;
}

function hitsPath(point: AnnotationPoint, points: readonly AnnotationPoint[], maxSquared: number): boolean {
  let previous = points[0];
  if (!previous) return false;
  if (points.length === 1) return segmentDistanceSquared(point, previous, previous) <= maxSquared;
  for (let index = 1; index < points.length; index++) {
    const next = points[index];
    if (!next) continue;
    if (segmentDistanceSquared(point, previous, next) <= maxSquared) return true;
    previous = next;
  }
  return false;
}

function expand(rect: AnnotationRect, distance: number): AnnotationRect {
  return { x: rect.x - distance, y: rect.y - distance, width: rect.width + distance * 2, height: rect.height + distance * 2 };
}

function roundedOutlineDistance(point: AnnotationPoint, rect: AnnotationRect, radius: number): number {
  const rx = rect.width / 2;
  const ry = rect.height / 2;
  const r = Math.min(radius, rx, ry);
  const x = Math.abs(point.x - rect.x - rx) - rx + r;
  const y = Math.abs(point.y - rect.y - ry) - ry + r;
  return Math.abs(Math.hypot(Math.max(0, x), Math.max(0, y)) + Math.min(Math.max(x, y), 0) - r);
}

function ellipseDistance(point: AnnotationPoint, rect: AnnotationRect): number {
  const rx = rect.width / 2;
  const ry = rect.height / 2;
  const dx = Math.abs(point.x - rect.x - rx);
  const dy = Math.abs(point.y - rect.y - ry);
  const [a, b, x, y] = rx >= ry ? [rx, ry, dx, dy] : [ry, rx, dy, dx];
  if (a === b) return Math.abs(Math.hypot(x, y) - a);
  if (y === 0) {
    const cos = Math.min(1, (a * x) / (a ** 2 - b ** 2));
    return Math.hypot(a * cos - x, b * Math.sqrt(1 - cos ** 2));
  }

  // Solve the closest-point constraint on the ellipse in its first quadrant.
  const ax = a * x;
  const by = b * y;
  let low = -(b ** 2);
  let high = Math.hypot(ax, by);
  for (let step = 0; step < 48; step++) {
    const mid = (low + high) / 2;
    if (Math.hypot(ax / (a ** 2 + mid), by / (b ** 2 + mid)) > 1) low = mid;
    else high = mid;
  }
  return Math.hypot((a * ax) / (a ** 2 + high) - x, (b * by) / (b ** 2 + high) - y);
}
