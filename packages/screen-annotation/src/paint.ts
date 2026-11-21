import type { ScreenAnnotationMark, ScreenAnnotationPoint } from "@q9labsai/chalk-client";

import { containsPoint, intersectRects, projectFramePoint, type AnnotationPoint, type AnnotationRect } from "./geometry";
import { ANNOTATION_FONT_FAMILY, HIGHLIGHTER_OPACITY, NOTE_COLOR, NOTE_OPACITY, annotationMarkOpacity, compareAnnotationMarks, layoutAnnotationText, projectAnnotationMark, type AnnotationMarkGeometry, type AnnotationTextMeasure } from "./mark-geometry";
import { LASER_TRAIL_MS, type AnnotationPresence } from "./presence";

export interface AnnotationCanvasContext {
  globalAlpha: number;
  globalCompositeOperation: string;
  lineWidth: number;
  lineCap: string;
  lineJoin: string;
  fillStyle: string | object;
  strokeStyle: string | object;
  shadowBlur: number;
  shadowOffsetX: number;
  shadowOffsetY: number;
  font: string;
  textBaseline: string;
  textAlign: string;
  save(): void;
  restore(): void;
  beginPath(): void;
  closePath(): void;
  rect(x: number, y: number, width: number, height: number): void;
  arc(x: number, y: number, radius: number, start: number, end: number): void;
  ellipse(x: number, y: number, rx: number, ry: number, rotation: number, start: number, end: number): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  setLineDash(segments: number[]): void;
  clip(): void;
  fill(): void;
  stroke(): void;
  fillText(text: string, x: number, y: number): void;
  measureText(text: string): { readonly width: number };
}

export type PaintAnnotationOptions = {
  readonly rect: AnnotationRect;
  readonly clip?: AnnotationRect;
  readonly sharerId?: string;
  readonly paused?: boolean;
  readonly marks: readonly ScreenAnnotationMark[];
  readonly presence?: readonly AnnotationPresence[];
  readonly localTouch?: ScreenAnnotationPoint;
  readonly nowMs: number;
};

export function annotationFont(size: number): string {
  return `600 ${size}px "${ANNOTATION_FONT_FAMILY}", sans-serif`;
}

export function canvasAnnotationTextMeasure(ctx: Pick<AnnotationCanvasContext, "font" | "measureText" | "save" | "restore">): AnnotationTextMeasure {
  return (text, size) => {
    ctx.save();
    try {
      ctx.font = annotationFont(size);
      return ctx.measureText(text).width;
    } finally {
      ctx.restore();
    }
  };
}

export function paintAnnotation(ctx: AnnotationCanvasContext, { rect, clip = rect, sharerId, paused, marks, presence = [], localTouch, nowMs }: PaintAnnotationOptions): void {
  const visible = intersectRects(rect, clip);
  if (!visible) return;
  ctx.save();
  try {
    ctx.globalCompositeOperation = "source-over";
    ctx.lineJoin = "round";
    ctx.setLineDash([]);
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.shadowBlur = 0;
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 0;
    ctx.beginPath();
    ctx.rect(visible.x, visible.y, visible.width, visible.height);
    ctx.clip();

    for (const mark of [...marks].sort(compareAnnotationMarks)) {
      if (paused && mark.author.participant_id !== sharerId) continue;
      const opacity = annotationMarkOpacity(mark, nowMs);
      if (opacity > 0) paintMark(ctx, projectAnnotationMark(rect, mark.draft), opacity);
    }

    const live = presence.filter((sample) => sample.expires_at_ms > nowMs && (!paused || sample.author.participant_id === sharerId));
    const acceptedIds = new Set(marks.map((mark) => mark.draft.mark_id));
    for (const { draft } of live) {
      if (draft && !acceptedIds.has(draft.mark_id)) paintMark(ctx, projectAnnotationMark(rect, draft), 1);
    }
    for (const sample of live) {
      paintCursor(ctx, rect, visible, sample, nowMs);
    }
    if (localTouch) {
      const point = projectFramePoint(rect, localTouch);
      ctx.globalAlpha = 1;
      ctx.beginPath();
      ctx.arc(point.x, point.y, 12, 0, Math.PI * 2);
      ctx.lineWidth = 3;
      ctx.strokeStyle = "#000a";
      ctx.stroke();
      ctx.lineWidth = 1;
      ctx.strokeStyle = "#fff";
      ctx.stroke();
    }
  } finally {
    ctx.restore();
  }
}

function paintMark(ctx: AnnotationCanvasContext, geometry: AnnotationMarkGeometry, opacity: number): void {
  const { color, width } = geometry;
  ctx.globalAlpha = opacity;
  ctx.fillStyle = color;
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.lineCap = "round";

  switch (geometry.kind) {
    case "highlighter":
      ctx.globalAlpha *= HIGHLIGHTER_OPACITY;
      ctx.lineCap = "butt";
      strokePath(ctx, geometry.points);
      break;
    case "pen":
      strokePath(ctx, geometry.points);
      break;
    case "line":
    case "arrow":
      strokePath(ctx, [geometry.from, geometry.to]);
      if (geometry.kind === "arrow" && tracePath(ctx, geometry.head)) {
        ctx.closePath();
        ctx.fill();
      }
      break;
    case "box":
    case "circle":
      paintShape(ctx, geometry.kind, geometry.bounds, width);
      break;
    case "text": {
      ctx.font = annotationFont(geometry.fontSize);
      const text = layoutAnnotationText(geometry, (line) => ctx.measureText(line).width);
      if (geometry.note) {
        ctx.globalAlpha *= NOTE_OPACITY;
        ctx.fillStyle = NOTE_COLOR;
        roundedRect(ctx, text.noteBounds, text.radius);
        ctx.fill();
        ctx.fillStyle = color;
        ctx.globalAlpha = opacity;
      }
      text.lines.forEach((line, index) => ctx.fillText(line, geometry.at.x, geometry.at.y + text.lineHeight * index));
      break;
    }
    case "stamp":
      ctx.globalAlpha *= NOTE_OPACITY;
      ctx.fillStyle = NOTE_COLOR;
      dot(ctx, geometry.at, geometry.radius);
      ctx.globalAlpha = opacity;
      ctx.stroke();
      ctx.fillStyle = color;
      for (const path of geometry.paths) strokePath(ctx, path);
      break;
  }
}

function paintShape(ctx: AnnotationCanvasContext, kind: "box" | "circle", bounds: AnnotationRect, strokeWidth: number): void {
  const { x, y, width, height } = bounds;
  if (width === 0 || height === 0) {
    strokePath(ctx, [
      { x, y },
      { x: x + width, y: y + height },
    ]);
    return;
  }
  if (kind === "box") {
    roundedRect(ctx, bounds, strokeWidth * 2);
  } else {
    ctx.beginPath();
    ctx.ellipse(x + width / 2, y + height / 2, width / 2, height / 2, 0, 0, Math.PI * 2);
  }
  ctx.stroke();
}

function roundedRect(ctx: AnnotationCanvasContext, bounds: AnnotationRect, radius: number): void {
  const { x, y, width, height } = bounds;
  const r = Math.min(radius, width / 2, height / 2);
  const right = x + width;
  const bottom = y + height;
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(right - r, y);
  ctx.arc(right - r, y + r, r, -Math.PI / 2, 0);
  ctx.lineTo(right, bottom - r);
  ctx.arc(right - r, bottom - r, r, 0, Math.PI / 2);
  ctx.lineTo(x + r, bottom);
  ctx.arc(x + r, bottom - r, r, Math.PI / 2, Math.PI);
  ctx.lineTo(x, y + r);
  ctx.arc(x + r, y + r, r, Math.PI, Math.PI * 1.5);
  ctx.closePath();
}

function tracePath(ctx: AnnotationCanvasContext, points: readonly AnnotationPoint[]): boolean {
  const first = points[0];
  if (!first) return false;
  ctx.beginPath();
  ctx.moveTo(first.x, first.y);
  for (let index = 1; index < points.length; index++) {
    const point = points[index];
    if (point) ctx.lineTo(point.x, point.y);
  }
  return true;
}

function strokePath(ctx: AnnotationCanvasContext, points: readonly AnnotationPoint[]): void {
  const first = points[0];
  if (!first) return;
  if (points.every((point) => point.x === first.x && point.y === first.y)) {
    dot(ctx, first, ctx.lineWidth / 2);
  } else if (tracePath(ctx, points)) {
    ctx.stroke();
  }
}

function dot(ctx: AnnotationCanvasContext, point: AnnotationPoint, radius: number): void {
  ctx.beginPath();
  ctx.arc(point.x, point.y, radius, 0, Math.PI * 2);
  ctx.fill();
}

function paintCursor(ctx: AnnotationCanvasContext, rect: AnnotationRect, clip: AnnotationRect, sample: AnnotationPresence, nowMs: number): void {
  if (!sample.cursor) return;
  const point = projectFramePoint(rect, sample.cursor.point);
  const color = sample.author.color;
  const unit = Math.max(0.7, Math.min(1.5, rect.width / 1000));
  const pointer = sample.cursor.tool === "pointer";
  const freshness = Math.max(0, 1 - (nowMs - sample.server_at_ms) / LASER_TRAIL_MS);
  if (pointer) {
    if (freshness === 0) return;
    ctx.strokeStyle = color;
    ctx.lineCap = "round";
    for (let index = 1; index < (sample.laserTrail?.length ?? 0); index++) {
      const previous = sample.laserTrail?.[index - 1];
      const next = sample.laserTrail?.[index];
      if (!previous || !next) continue;
      const fraction = Math.max(0, Math.min(1, 1 - (nowMs - previous.atMs) / LASER_TRAIL_MS));
      if (fraction === 0) continue;
      ctx.globalAlpha = fraction * 0.9;
      ctx.lineWidth = (2 + fraction * 3) * unit;
      ctx.fillStyle = color;
      strokePath(ctx, [projectFramePoint(rect, previous.point), projectFramePoint(rect, next.point)]);
    }
    const opacity = Math.min(1, freshness * 3);
    ctx.fillStyle = color;
    ctx.globalAlpha = 0.14 * opacity;
    dot(ctx, point, 10 * unit);
    ctx.globalAlpha = 0.26 * opacity;
    dot(ctx, point, 7 * unit);
    ctx.globalAlpha = opacity;
    dot(ctx, point, 5 * unit);
    ctx.fillStyle = "#fff";
    dot(ctx, point, 2 * unit);
  } else {
    ctx.globalAlpha = 1;
    ctx.fillStyle = color;
    ctx.strokeStyle = "#0009";
    ctx.lineWidth = unit;
    tracePath(ctx, [point, { x: point.x, y: point.y + 14 * unit }, { x: point.x + 4 * unit, y: point.y + 10.5 * unit }, { x: point.x + 9.5 * unit, y: point.y + 10.5 * unit }]);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  }

  if (!containsPoint(clip, point)) return;
  ctx.font = annotationFont(11 * unit);
  const label = sample.author.display_name;
  const width = ctx.measureText(label).width + 12 * unit;
  const height = 18 * unit;
  const x = Math.max(clip.x, Math.min(point.x + 9 * unit, clip.x + clip.width - width));
  const y = Math.max(clip.y, Math.min(point.y + 12 * unit, clip.y + clip.height - height));
  ctx.fillStyle = color;
  roundedRect(ctx, { x, y, width, height }, height / 2);
  ctx.fill();
  ctx.fillStyle = "#0b0b0d";
  ctx.fillText(label, x + 6 * unit, y + height / 2);
}
