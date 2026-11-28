import { annotationFont, type AnnotationCanvasContext } from "./canvas";
import type { AnnotationPoint, AnnotationRect } from "./geometry";
import type { AnnotationMarkGeometry } from "./mark-geometry";

export function labelUnit(rect: AnnotationRect): number {
  return Math.max(0.7, Math.min(1.5, rect.width / 1000));
}

export function firstName(displayName: string): string {
  return displayName.trim().split(/\s+/u)[0] || displayName;
}

/** A pill in the author's ink with the name in black or white, whichever reads better on that ink. */
export function paintNameTag(ctx: AnnotationCanvasContext, clip: AnnotationRect, at: AnnotationPoint, name: string, color: string, unit: number): void {
  ctx.font = annotationFont(11 * unit);
  const width = ctx.measureText(name).width + 12 * unit;
  const height = 18 * unit;
  const x = Math.max(clip.x, Math.min(at.x, clip.x + clip.width - width));
  const y = Math.max(clip.y, Math.min(at.y, clip.y + clip.height - height));
  ctx.fillStyle = color;
  roundedRect(ctx, { x, y, width, height }, height / 2);
  ctx.fill();
  ctx.fillStyle = inkIsLight(color) ? "#0b0b0d" : "#ffffff";
  ctx.fillText(name, x + 6 * unit, y + height / 2);
}

function inkIsLight(color: string): boolean {
  const hex = /^#([0-9a-f]{6})$/iu.exec(color)?.[1];
  if (!hex) return true;
  const [r, g, b] = [0, 2, 4].map((offset) => {
    const channel = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  const luminance = 0.2126 * (r ?? 0) + 0.7152 * (g ?? 0) + 0.0722 * (b ?? 0);
  return (luminance + 0.05) / 0.05 >= 1.05 / (luminance + 0.05);
}

/** Where a mark's name sits: just past where the stroke ended, or below and right of a shape. */
export function markAnchor(geometry: AnnotationMarkGeometry): AnnotationPoint {
  const gap = geometry.width / 2 + 4;
  switch (geometry.kind) {
    case "pen":
    case "highlighter": {
      const end = geometry.points.at(-1) ?? { x: 0, y: 0 };
      return { x: end.x + gap, y: end.y + gap };
    }
    case "line":
    case "arrow":
      return { x: geometry.to.x + gap, y: geometry.to.y + gap };
    case "box":
    case "circle":
      return { x: geometry.bounds.x + geometry.bounds.width + gap, y: geometry.bounds.y + geometry.bounds.height + gap };
    case "text":
      return { x: geometry.at.x, y: geometry.at.y + geometry.fontSize };
    case "stamp":
      return { x: geometry.at.x + geometry.radius, y: geometry.at.y + geometry.radius };
  }
}

export function roundedRect(ctx: AnnotationCanvasContext, bounds: AnnotationRect, radius: number): void {
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
