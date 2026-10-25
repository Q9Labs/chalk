import type { WhiteboardView as ChalkWhiteboardView, WhiteboardViewBounds } from "../../collab/view";
import type { WhoCanDraw } from "./board-draw-policy";

/** design.md, "The board": every colour, size and key the board's own controls use. */
export type BoardSurface = "chalkboard" | "paper" | "dots";
export type IslandPlace = "bottom" | "top" | "left";
export type CallTheme = "light" | "dark";
export type PenColor = "ink" | "red" | "orange" | "green" | "blue" | "violet";
export type PenWidth = "thin" | "medium" | "thick";
export type ShapeTool = "rectangle" | "ellipse" | "diamond" | "arrow" | "line";
export type BoardTool = "selection" | "hand" | "pen" | "highlighter" | ShapeTool | "text" | "note" | "eraser" | "laser";

export const SURFACES: readonly { readonly id: BoardSurface; readonly label: string }[] = [
  { id: "chalkboard", label: "Chalkboard" },
  { id: "paper", label: "Paper" },
  { id: "dots", label: "Dot grid" },
];

export const ISLAND_PLACES: readonly { readonly id: IslandPlace; readonly label: string }[] = [
  { id: "left", label: "Left" },
  { id: "bottom", label: "Bottom" },
  { id: "top", label: "Top" },
];

export const DRAW_POLICIES: readonly { readonly id: WhoCanDraw["policy"]; readonly label: string }[] = [
  { id: "everyone", label: "Everyone" },
  { id: "hosts", label: "Only hosts" },
  { id: "picked", label: "Picked people" },
];

export const PEN_COLORS: readonly { readonly id: PenColor; readonly label: string }[] = [
  { id: "ink", label: "Ink" },
  { id: "red", label: "Red" },
  { id: "orange", label: "Orange" },
  { id: "green", label: "Green" },
  { id: "blue", label: "Blue" },
  { id: "violet", label: "Violet" },
];

const PEN_HEX: Record<Exclude<PenColor, "ink">, string> = { red: "#e23240", orange: "#c15a10", green: "#288a51", blue: "#1f7ad6", violet: "#935ae2" };

export const NOTE_FILL: Record<PenColor, string> = { ink: "#f6e27a", red: "#f2a3a8", orange: "#f4be8c", green: "#a8dbb8", blue: "#a9cdf2", violet: "#cdb8f2" };
/** Note text is a hair off Ink's canonical colour, so it never turns light with the surface. */
export const NOTE_TEXT = "#1b1c1e";
export const NOTE_SIZE = { width: 170, height: 150 } as const;
/** A 4px corner, as in the mockup; the engine's default rounding is 32px. */
export const NOTE_ROUNDNESS = { type: 3, value: 4 } as const;

export const PEN_WIDTHS: readonly { readonly id: PenWidth; readonly label: string; readonly units: number }[] = [
  { id: "thin", label: "Thin", units: 2.5 },
  { id: "medium", label: "Medium", units: 4.5 },
  { id: "thick", label: "Thick", units: 8 },
];

export const SHAPES: readonly { readonly id: ShapeTool; readonly label: string; readonly key: string }[] = [
  { id: "rectangle", label: "Rectangle", key: "R" },
  { id: "ellipse", label: "Ellipse", key: "O" },
  { id: "diamond", label: "Diamond", key: "D" },
  { id: "arrow", label: "Arrow", key: "A" },
  { id: "line", label: "Line", key: "L" },
];

export const TOOL_KEYS: Readonly<Record<string, BoardTool>> = { v: "selection", h: "hand", p: "pen", u: "highlighter", r: "rectangle", o: "ellipse", d: "diamond", a: "arrow", l: "line", t: "text", n: "note", e: "eraser", k: "laser" };

const PERSON_COLORS = ["#1d70c5", "#8753d0", "#d02e3b", "#257f4b", "#b2530f", "#1b7979", "#c0307a", "#62751d", "#3b6fd4", "#a14fb5", "#b5512c", "#297f65"] as const;

export function personColor(index: number): string {
  return PERSON_COLORS[((index % PERSON_COLORS.length) + PERSON_COLORS.length) % PERSON_COLORS.length]!;
}

const DARK_SURFACES = new Set<string>(["chalkboard", "dots-dark"]);

function surfaceKey(surface: BoardSurface, theme: CallTheme): string {
  return surface === "dots" ? `dots-${theme}` : surface;
}

export function isDarkSurface(surface: BoardSurface, theme: CallTheme): boolean {
  return DARK_SURFACES.has(surfaceKey(surface, theme));
}

/** The surface's own ink, which is what Ink looks like on it. */
export function surfaceInk(surface: BoardSurface, theme: CallTheme): string {
  if (surface === "chalkboard") return "#f1f0ea";
  if (surface === "paper") return "#1b1c1f";
  return theme === "dark" ? "#ececee" : "#18181b";
}

/** The fill behind the drawing, also used as the background of an exported image. */
export function surfaceFill(surface: BoardSurface, theme: CallTheme): string {
  if (surface === "chalkboard") return "#1c2622";
  if (surface === "paper") return theme === "dark" ? "#eae6db" : "#f5f2ea";
  return theme === "dark" ? "#151619" : "#ffffff";
}

export function selectionColor(surface: BoardSurface, theme: CallTheme): string {
  return isDarkSurface(surface, theme) ? "#7db8ff" : "#1f6fd0";
}

export function penHex(color: PenColor, surface: BoardSurface, theme: CallTheme): string {
  return color === "ink" ? surfaceInk(surface, theme) : PEN_HEX[color];
}

/** The highlighter has no Ink: it draws orange instead, four times as wide at 40% opacity. */
export function highlighterStyle(color: PenColor, width: PenWidth): { readonly strokeColor: string; readonly strokeWidth: number; readonly opacity: number } {
  return { strokeColor: PEN_HEX[color === "ink" ? "orange" : color], strokeWidth: widthUnits(width) * 4, opacity: 40 };
}

/** Excalidraw draws a freehand stroke 4.25 times as wide as its strokeWidth, and a shape's outline at its strokeWidth. */
const FREEHAND_SCALE = 4.25;

export function engineStrokeWidth(px: number, freehand: boolean): number {
  return freehand ? px / FREEHAND_SCALE : px;
}

export function widthUnits(width: PenWidth): number {
  return PEN_WIDTHS.find((entry) => entry.id === width)!.units;
}

export const MIN_ZOOM = 0.1;
export const MAX_ZOOM = 4;

export function clampZoom(zoom: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
}

export type Camera = { readonly scrollX: number; readonly scrollY: number; readonly zoom: number };
export type Viewport = { readonly width: number; readonly height: number };

/** The part of the board this camera shows, in board coordinates. */
export function visibleView(camera: Camera, viewport: Viewport, bounds: WhiteboardViewBounds): Omit<ChalkWhiteboardView, "bring"> {
  const { maxCoordinate, maxExtent } = bounds;
  return {
    x: Math.max(-maxCoordinate, Math.min(maxCoordinate, -camera.scrollX)),
    y: Math.max(-maxCoordinate, Math.min(maxCoordinate, -camera.scrollY)),
    width: Math.min(maxExtent, viewport.width / camera.zoom),
    height: Math.min(maxExtent, viewport.height / camera.zoom),
  };
}

/** The camera that fits someone else's view into this viewport, centred. */
export function cameraForView(view: Omit<ChalkWhiteboardView, "bring">, viewport: Viewport): Camera {
  const zoom = clampZoom(Math.min(viewport.width / view.width, viewport.height / view.height));
  return { zoom, scrollX: viewport.width / (2 * zoom) - (view.x + view.width / 2), scrollY: viewport.height / (2 * zoom) - (view.y + view.height / 2) };
}

/** The camera after zooming to `zoom` around the viewport's centre. */
export function zoomAroundCentre(camera: Camera, viewport: Viewport, zoom: number): Camera {
  const next = clampZoom(zoom);
  const centreX = viewport.width / 2 / camera.zoom - camera.scrollX;
  const centreY = viewport.height / 2 / camera.zoom - camera.scrollY;
  return { zoom: next, scrollX: viewport.width / 2 / next - centreX, scrollY: viewport.height / 2 / next - centreY };
}

export function sameCamera(left: Camera, right: Camera): boolean {
  return Math.abs(left.zoom - right.zoom) < 1e-4 && Math.abs(left.scrollX - right.scrollX) < 0.5 && Math.abs(left.scrollY - right.scrollY) < 0.5;
}

export function mixCamera(from: Camera, to: Camera, progress: number): Camera {
  // Zoom eases on a log scale so a large change does not rush at the start.
  const zoom = Math.exp(Math.log(from.zoom) + (Math.log(to.zoom) - Math.log(from.zoom)) * progress);
  return { zoom, scrollX: from.scrollX + (to.scrollX - from.scrollX) * progress, scrollY: from.scrollY + (to.scrollY - from.scrollY) * progress };
}

/** A critically damped spring step, exact for any frame time. Returns the new offset from the target and the new velocity. */
export function springStep(offset: number, velocity: number, rate: number, seconds: number): readonly [number, number] {
  const decay = Math.exp(-rate * seconds);
  const drift = (velocity + rate * offset) * seconds;
  return [(offset + drift) * decay, (velocity - rate * drift) * decay];
}

export function readStored<T extends string>(key: string, allowed: readonly { readonly id: T }[], fallback: T): T {
  try {
    const value = globalThis.localStorage?.getItem(key);
    return allowed.find((entry) => entry.id === value)?.id ?? fallback;
  } catch {
    return fallback;
  }
}

export function writeStored(key: string, value: string): void {
  try {
    globalThis.localStorage?.setItem(key, value);
  } catch {
    // Private windows can refuse storage; the choice still applies until the page closes.
  }
}
