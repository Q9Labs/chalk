import type { ChalkEmbeddedWhiteboardViewport } from "@q9labsai/chalk-whiteboard/embedded";

export function createEmbeddedWhiteboardViewport(width: number, height: number, scale: number): ChalkEmbeddedWhiteboardViewport | null {
  if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(height) || height <= 0 || !Number.isFinite(scale) || scale <= 0) return null;
  return { width, height, scale };
}
