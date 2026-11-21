import type { ScreenAnnotationClient, ScreenAnnotationDraft, ScreenAnnotationFrameSize, ScreenAnnotationMark, ScreenAnnotationPoint, ScreenAnnotationPresence, ScreenAnnotationState, ScreenAnnotationTarget } from "@q9labsai/chalk-client";

export type AnnotationRect = { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
export type AnnotationFit = "fit" | "fill";
export type AnnotationAuthor = ScreenAnnotationMark["author"];

export interface ScreenAnnotationRenderer {
  contentRect(frame: ScreenAnnotationFrameSize, viewport: AnnotationRect, fit: AnnotationFit): AnnotationRect | null;
  framePoint(rect: AnnotationRect, point: ScreenAnnotationPoint): ScreenAnnotationPoint | null;
  simplifyStroke(points: readonly ScreenAnnotationPoint[]): readonly ScreenAnnotationPoint[];
  hitTest(input: { readonly state: ScreenAnnotationState; readonly point: ScreenAnnotationPoint; readonly frame: ScreenAnnotationFrameSize; readonly actorId: string; readonly nowMs: number }): ScreenAnnotationMark | undefined;
  paintAnnotation(
    ctx: CanvasRenderingContext2D,
    input: {
      readonly rect: AnnotationRect;
      readonly clip: AnnotationRect;
      readonly sharerId: string;
      readonly paused: boolean;
      readonly marks: readonly ScreenAnnotationMark[];
      readonly presence: readonly ScreenAnnotationPresence[];
      readonly nowMs: number;
    },
  ): void;
}

/** A detached, pristine copy of the decoded frame and its accepted ink at action time. */
export interface ScreenAnnotationFrame {
  readonly publicationId: string;
  readonly size: ScreenAnnotationFrameSize;
  readonly video: HTMLCanvasElement;
  readonly marks: readonly ScreenAnnotationMark[];
  readonly nowMs: number;
}

export interface ScreenAnnotationActions {
  readonly saveToWhiteboard?: (frame: ScreenAnnotationFrame) => Promise<void>;
  readonly downloadPng?: (frame: ScreenAnnotationFrame) => Promise<void>;
}

export interface ScreenAnnotationOptions {
  readonly client: ScreenAnnotationClient;
  readonly publicationId: string;
  readonly actions?: ScreenAnnotationActions;
  readonly renderer?: ScreenAnnotationRenderer;
}

export type AnnotationTool = ScreenAnnotationDraft["shape"]["kind"] | "pointer" | "eraser";
export type AnnotationStamp = Extract<ScreenAnnotationDraft["shape"], { kind: "stamp" }>["stamp"];

export interface AnnotationBrush {
  readonly tool: AnnotationTool;
  readonly color?: string;
  readonly width: number;
  readonly keep: boolean;
  readonly stamp: AnnotationStamp;
}

export const defaultBrush: AnnotationBrush = { tool: "pen", width: 192, keep: false, stamp: "check" };

export function targetOf(state: ScreenAnnotationState): ScreenAnnotationTarget {
  return { layerId: state.layer.layer_id, fence: state.fence };
}

export function canDraw(state: ScreenAnnotationState, actorId: string): boolean {
  return state.access.can_draw && (!state.paused || state.layer.sharer_id === actorId);
}

export function matchesTarget(client: ScreenAnnotationClient, target: ScreenAnnotationTarget): ScreenAnnotationState | null {
  const snapshot = client.getSnapshot();
  const state = snapshot.status === "ready" ? snapshot.state : null;
  return state?.layer.layer_id === target.layerId && state.fence === target.fence ? state : null;
}

export function visibleMarks(state: ScreenAnnotationState, nowMs: number): readonly ScreenAnnotationMark[] {
  return state.marks.filter((mark) => (!state.paused || mark.author.participant_id === state.layer.sharer_id) && (mark.expires_at_ms === null || mark.expires_at_ms > nowMs));
}

export function freezeFrame(video: HTMLVideoElement, state: ScreenAnnotationState, nowMs: number): ScreenAnnotationFrame {
  const size = decodedSize(video);
  if (!size) throw new Error("Wait for the shared video to play before saving a frame.");
  const frame = video.ownerDocument.createElement("canvas");
  frame.width = size.width;
  frame.height = size.height;
  const context = frame.getContext("2d");
  if (!context) throw new Error("This browser cannot capture the shared frame.");
  context.drawImage(video, 0, 0, size.width, size.height);
  return { publicationId: state.layer.publication_id, size, video: frame, marks: structuredClone(visibleMarks(state, nowMs)), nowMs };
}

export function decodedSize(video: HTMLVideoElement | null): ScreenAnnotationFrameSize | null {
  return video && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && video.videoWidth > 0 && video.videoHeight > 0 ? { width: video.videoWidth, height: video.videoHeight } : null;
}
