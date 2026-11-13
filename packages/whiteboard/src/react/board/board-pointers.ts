import type { Camera, Viewport } from "./board-model";

type ScreenPoint = { readonly x: number; readonly y: number };
export type Edge = "left" | "right" | "top" | "bottom";
type EdgePointer = { readonly edge: Edge; readonly x: number; readonly y: number; /** Degrees clockwise from pointing right, towards the cursor. */ readonly angle: number };
type Insets = { readonly top: number; readonly right: number; readonly bottom: number; readonly left: number };

/** The tag sits 12px right of the arrow and 18px below it, as in the stylesheet. */
const TAG_OFFSET_X = 12;
const TAG_OFFSET_Y = 18;
/** Flipped, it sits left of the arrow's tip and above it. */
const FLIP_GAP_X = 6;
const FLIP_GAP_Y = 8;
/** How far a side chip sits from the edge it left through. */
const EDGE_GAP = 8;
/** A cursor's name stays up this long after its last update, so a pause does not hide who it is. */
const TAG_RECENT_MS = 4000;

export function toScreen(camera: Camera, point: ScreenPoint): ScreenPoint {
  return { x: (point.x + camera.scrollX) * camera.zoom, y: (point.y + camera.scrollY) * camera.zoom };
}

/** Whether the tag should swing to the other side of the arrow: it would leave the board on this side and has more room on the other. */
function overflows(position: number, size: number, extent: number, after: number, before: number): boolean {
  const roomAfter = extent - position - after;
  return size > roomAfter && position - before > roomAfter;
}

export function tagFlip(cursor: ScreenPoint, tag: { readonly width: number; readonly height: number }, viewport: Viewport): { readonly x: boolean; readonly y: boolean } {
  return { x: overflows(cursor.x, tag.width, viewport.width, TAG_OFFSET_X, FLIP_GAP_X), y: overflows(cursor.y, tag.height, viewport.height, TAG_OFFSET_Y, FLIP_GAP_Y) };
}

export function tagVisible(ageMs: number, near: boolean): boolean {
  return near || ageMs < TAG_RECENT_MS;
}

/**
 * Where the chip for a cursor outside the view sits: on the edge it left through, slid along that edge to match (never closer to a corner than the insets),
 * and turned towards the cursor. Null while the cursor is in view. Top and bottom chips sit at their insets, so they clear what the board keeps in its corners.
 */
export function edgePointer(cursor: ScreenPoint, viewport: Viewport, insets: Insets): EdgePointer | null {
  const overX = cursor.x < 0 ? cursor.x : cursor.x > viewport.width ? cursor.x - viewport.width : 0;
  const overY = cursor.y < 0 ? cursor.y : cursor.y > viewport.height ? cursor.y - viewport.height : 0;
  if (overX === 0 && overY === 0) return null;
  const x = Math.min(viewport.width - insets.right, Math.max(insets.left, cursor.x));
  const y = Math.min(viewport.height - insets.bottom, Math.max(insets.top, cursor.y));
  const angle = (Math.atan2(cursor.y - y, cursor.x - x) * 180) / Math.PI;
  if (Math.abs(overX) >= Math.abs(overY)) return { edge: overX < 0 ? "left" : "right", x: overX < 0 ? EDGE_GAP : viewport.width - EDGE_GAP, y, angle };
  return { edge: overY < 0 ? "top" : "bottom", x, y: overY < 0 ? insets.top : viewport.height - insets.bottom, angle };
}
