export type SharerEdge = "top" | "bottom" | "left" | "right";
export type SharerLook = "island" | "pill";

/** Where the sharer's control sits: an edge of the share tile and a 0..1 position along it. */
export interface SharerLayout {
  readonly look: SharerLook;
  readonly edge: SharerEdge;
  readonly offset: number;
}

export const defaultSharerLayout: SharerLayout = { look: "island", edge: "top", offset: 0.5 };

const storageKey = "chalk.screen-annotation.sharer-control";
const edges: readonly SharerEdge[] = ["top", "bottom", "left", "right"];
const step = 0.1;

const clamp = (value: number) => Math.round(Math.min(1, Math.max(0, value)) * 1000) / 1000;

export function parseSharerLayout(raw: string | null): SharerLayout {
  if (!raw) return defaultSharerLayout;
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null) return defaultSharerLayout;
    const look = "look" in value && value.look === "pill" ? "pill" : "island";
    const edge = "edge" in value ? edges.find((candidate) => candidate === value.edge) : undefined;
    const offset = "offset" in value && typeof value.offset === "number" && Number.isFinite(value.offset) ? clamp(value.offset) : defaultSharerLayout.offset;
    return { look, edge: edge ?? defaultSharerLayout.edge, offset };
  } catch {
    return defaultSharerLayout;
  }
}

export function readSharerLayout(): SharerLayout {
  try {
    return parseSharerLayout(window.localStorage.getItem(storageKey));
  } catch {
    return defaultSharerLayout;
  }
}

export function saveSharerLayout(layout: SharerLayout): void {
  try {
    window.localStorage.setItem(storageKey, JSON.stringify(layout));
  } catch {
    // Storage can be blocked; the control still works for this session.
  }
}

/** Snap a pointer position inside the tile to its nearest edge, keeping the position along that edge. */
export function layoutAtPoint(layout: SharerLayout, point: { readonly x: number; readonly y: number }, box: { readonly left: number; readonly top: number; readonly width: number; readonly height: number }): SharerLayout {
  const x = clamp((point.x - box.left) / box.width);
  const y = clamp((point.y - box.top) / box.height);
  const nearest = [
    { edge: "left", distance: x },
    { edge: "right", distance: 1 - x },
    { edge: "top", distance: y },
    { edge: "bottom", distance: 1 - y },
  ] as const;
  const edge = nearest.reduce((best, candidate) => (candidate.distance < best.distance ? candidate : best)).edge;
  return { ...layout, edge, offset: edge === "top" || edge === "bottom" ? x : y };
}

export type ArrowKey = "ArrowUp" | "ArrowDown" | "ArrowLeft" | "ArrowRight";

const edgeOfKey: Record<ArrowKey, SharerEdge> = { ArrowUp: "top", ArrowDown: "bottom", ArrowLeft: "left", ArrowRight: "right" };

/** Arrow along the current edge slides the control; an arrow toward another edge moves it there. */
export function layoutAfterArrow(layout: SharerLayout, key: ArrowKey): SharerLayout {
  const target = edgeOfKey[key];
  const horizontal = layout.edge === "top" || layout.edge === "bottom";
  const alongEdge = horizontal ? target === "left" || target === "right" : target === "top" || target === "bottom";
  if (!alongEdge) return target === layout.edge ? layout : { ...layout, edge: target };
  const forward = target === "right" || target === "bottom";
  return { ...layout, offset: clamp(layout.offset + (forward ? step : -step)) };
}

export function isArrowKey(key: string): key is ArrowKey {
  return key === "ArrowUp" || key === "ArrowDown" || key === "ArrowLeft" || key === "ArrowRight";
}
