import type { FacehashScene } from "./core/index";

export function sanitizeId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "-");
}

export function faceBoxTransform({ faceBox, faceGeometry }: FacehashScene): string {
  return `translate(${faceBox.x} ${faceBox.y}) scale(${faceBox.width / faceGeometry.viewBox.width} ${faceBox.height / faceGeometry.viewBox.height})`;
}
