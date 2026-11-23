import { ANNOTATION_FONT_FAMILY, type AnnotationTextMeasure } from "./mark-geometry";

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
