import type { ScreenAnnotationFrameSize, ScreenAnnotationPoint } from "@q9labsai/chalk-client";

export type AnnotationPoint = { readonly x: number; readonly y: number };
export type AnnotationRect = AnnotationPoint & ScreenAnnotationFrameSize;
export type AnnotationFit = "fit" | "fill";

export const FRAME_UNITS = 65535;

export function contentRect(frame: ScreenAnnotationFrameSize, viewport: AnnotationRect, fit: AnnotationFit): AnnotationRect | null {
  if (![frame.width, frame.height, viewport.width, viewport.height].every((size) => Number.isFinite(size) && size > 0)) return null;
  if (!Number.isFinite(viewport.x) || !Number.isFinite(viewport.y)) return null;
  const sx = viewport.width / frame.width;
  const sy = viewport.height / frame.height;
  const scale = fit === "fit" ? Math.min(sx, sy) : Math.max(sx, sy);
  const width = frame.width * scale;
  const height = frame.height * scale;
  return {
    x: viewport.x + (viewport.width - width) / 2,
    y: viewport.y + (viewport.height - height) / 2,
    width,
    height,
  };
}

export function intersectRects(a: AnnotationRect, b: AnnotationRect): AnnotationRect | null {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const width = Math.min(a.x + a.width, b.x + b.width) - x;
  const height = Math.min(a.y + a.height, b.y + b.height) - y;
  return width > 0 && height > 0 ? { x, y, width, height } : null;
}

export function containsPoint(rect: AnnotationRect, point: AnnotationPoint): boolean {
  return point.x >= rect.x && point.y >= rect.y && point.x <= rect.x + rect.width && point.y <= rect.y + rect.height;
}

export function framePoint(rect: AnnotationRect, point: AnnotationPoint): ScreenAnnotationPoint | null {
  if (!(rect.width > 0 && rect.height > 0) || !containsPoint(rect, point)) return null;
  return clampedFramePoint(rect, point);
}

export function clampedFramePoint(rect: AnnotationRect, point: AnnotationPoint): ScreenAnnotationPoint {
  return {
    x: Math.round(FRAME_UNITS * Math.max(0, Math.min(1, (point.x - rect.x) / rect.width))),
    y: Math.round(FRAME_UNITS * Math.max(0, Math.min(1, (point.y - rect.y) / rect.height))),
  };
}

export function projectFramePoint(rect: AnnotationRect, point: ScreenAnnotationPoint): AnnotationPoint {
  return {
    x: rect.x + (point.x / FRAME_UNITS) * rect.width,
    y: rect.y + (point.y / FRAME_UNITS) * rect.height,
  };
}

export function segmentDistanceSquared(point: AnnotationPoint, from: AnnotationPoint, to: AnnotationPoint): number {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const lengthSquared = dx * dx + dy * dy;
  const projected = lengthSquared === 0 ? 0 : ((point.x - from.x) * dx + (point.y - from.y) * dy) / lengthSquared;
  const t = Math.min(1, Math.max(0, projected));
  return (point.x - from.x - t * dx) ** 2 + (point.y - from.y - t * dy) ** 2;
}

const MAX_STROKE_POINTS = 384;

/** Retain the endpoints and the largest deviations from straight segments, in wire units. */
export function simplifyStroke(points: readonly ScreenAnnotationPoint[], tolerance = 8): readonly ScreenAnnotationPoint[] {
  const unique = points.filter((point, index) => {
    const previous = points[index - 1];
    return !previous || point.x !== previous.x || point.y !== previous.y;
  });
  if (unique.length <= 2) return unique;

  const keep = new Set([0, unique.length - 1]);
  const candidates: { start: number; end: number; index: number; error: number }[] = [];
  const enqueue = (start: number, end: number) => {
    const from = unique[start];
    const to = unique[end];
    if (!from || !to) return;
    let index = start;
    let error = tolerance ** 2;
    for (let i = start + 1; i < end; i++) {
      const point = unique[i];
      if (!point) continue;
      const distance = segmentDistanceSquared(point, from, to);
      if (distance > error) {
        error = distance;
        index = i;
      }
    }
    if (index !== start) candidates.push({ start, end, index, error });
  };

  enqueue(0, unique.length - 1);
  while (candidates.length > 0 && keep.size < MAX_STROKE_POINTS) {
    candidates.sort((a, b) => a.error - b.error || b.index - a.index);
    const next = candidates.pop();
    if (!next) break;
    keep.add(next.index);
    enqueue(next.start, next.index);
    enqueue(next.index, next.end);
  }
  return unique.filter((_, index) => keep.has(index));
}
