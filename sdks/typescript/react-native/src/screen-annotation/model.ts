import type { ScreenAnnotationClient, ScreenAnnotationDraft, ScreenAnnotationFrameSize, ScreenAnnotationMark, ScreenAnnotationPoint, ScreenAnnotationShape, ScreenAnnotationState, ScreenAnnotationTarget } from "@q9labsai/chalk-client";
import type { Frame } from "../motion/MovingFrame";
import { contain } from "../stage/layout";

export type ScreenAnnotationFrame<Image = unknown> = {
  readonly publicationId: string;
  readonly size: ScreenAnnotationFrameSize;
  /** A pristine, retained frame from this specific video adapter, not a screenshot of the view. */
  readonly image: Image;
  readonly marks: readonly ScreenAnnotationMark[];
  readonly nowMs: number;
};

export type ScreenAnnotationActions<Image = unknown> = {
  readonly saveToWhiteboard?: (frame: ScreenAnnotationFrame<Image>) => Promise<void>;
  readonly downloadPng?: (frame: ScreenAnnotationFrame<Image>) => Promise<void>;
};

export type ScreenAnnotationSource = {
  readonly rendererUrl?: string;
  readonly size: ScreenAnnotationFrameSize;
  /** Capture the current decoded frame; return null if it is unavailable or changed size. */
  readonly captureFrame?: () => Promise<{ readonly image: unknown; readonly release?: () => void } | null>;
};

export type ScreenAnnotationOptions = {
  readonly client: ScreenAnnotationClient;
  readonly publicationId: string;
  readonly actions?: ScreenAnnotationActions;
};

export type StageAnnotation = Omit<ScreenAnnotationOptions, "publicationId"> & { readonly publicationId?: string; readonly boardSaveEnabled?: boolean };

export type Tool = ScreenAnnotationShape["kind"] | "laser" | "eraser";
export type Ink = {
  readonly tool: Tool;
  readonly lifetime: ScreenAnnotationDraft["lifetime"];
  readonly color: string;
  readonly width: number;
  readonly stamp: Extract<ScreenAnnotationShape, { kind: "stamp" }>["stamp"];
};

export type Viewport = { readonly x: number; readonly y: number; readonly zoom: number };
export const initialViewport: Viewport = { x: 0, y: 0, zoom: 1 };
const unit = 65535;
const clamp = (n: number, low: number, high: number): number => Math.max(low, Math.min(high, n));

export function visibleFrame(frame: ScreenAnnotationFrameSize, viewport: Frame, pan: Viewport): Frame {
  const fit = contain(viewport, frame.width / frame.height);
  return {
    x: fit.x + (fit.width * (1 - pan.zoom)) / 2 + pan.x,
    y: fit.y + (fit.height * (1 - pan.zoom)) / 2 + pan.y,
    width: fit.width * pan.zoom,
    height: fit.height * pan.zoom,
  };
}

export function framePoint(rect: Frame, point: ScreenAnnotationPoint, clip: boolean): ScreenAnnotationPoint | null {
  const x = (point.x - rect.x) / rect.width;
  const y = (point.y - rect.y) / rect.height;
  if (!Number.isFinite(x) || !Number.isFinite(y) || (!clip && (x < 0 || x > 1 || y < 0 || y > 1))) return null;
  return { x: Math.round(clamp(x, 0, 1) * unit), y: Math.round(clamp(y, 0, 1) * unit) };
}

export function pinchViewport(rect: Frame, base: Viewport, from: ScreenAnnotationPoint, to: ScreenAnnotationPoint, ratio: number): Viewport {
  const zoom = clamp(base.zoom * ratio, 1, 5);
  const scale = zoom / base.zoom;
  const dx = ((rect.width / base.zoom) * (zoom - 1)) / 2;
  const dy = ((rect.height / base.zoom) * (zoom - 1)) / 2;
  return {
    x: clamp(base.x + to.x - from.x + (from.x - rect.x - rect.width / 2) * (1 - scale), -dx, dx),
    y: clamp(base.y + to.y - from.y + (from.y - rect.y - rect.height / 2) * (1 - scale), -dy, dy),
    zoom,
  };
}

export function matchLayer(client: ScreenAnnotationClient, publicationId: string): ScreenAnnotationState | null {
  const snapshot = client.getSnapshot();
  return snapshot.status === "ready" && snapshot.state?.layer.publication_id === publicationId ? snapshot.state : null;
}

export function targetFor(state: ScreenAnnotationState): ScreenAnnotationTarget {
  return { layerId: state.layer.layer_id, fence: state.fence };
}

export function hasTarget(state: ScreenAnnotationState | null, target: ScreenAnnotationTarget): state is ScreenAnnotationState {
  return state?.layer.layer_id === target.layerId && state.fence === target.fence;
}

export function canCapture(state: ScreenAnnotationState, participantId: string): boolean {
  return state.access.can_draw && (!state.paused || state.layer.sharer_id === participantId);
}

export function visibleCommittedMarks(state: ScreenAnnotationState, nowMs: number): readonly ScreenAnnotationMark[] {
  return state.marks.filter(({ author, expires_at_ms }) => (expires_at_ms === null || expires_at_ms > nowMs) && (!state.paused || author.participant_id === state.layer.sharer_id));
}

/** Does not split a UTF-8 code point to meet the wire limit. */
export function boundedNote(value: string): string {
  let bytes = 0;
  let result = "";
  for (const character of value.trim()) {
    const code = character.codePointAt(0) ?? 0;
    bytes += code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4;
    if (bytes > 512) break;
    result += character;
  }
  return result;
}
