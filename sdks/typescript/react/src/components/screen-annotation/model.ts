import type { ScreenAnnotationClient, ScreenAnnotationDraft, ScreenAnnotationFrameSize, ScreenAnnotationMark, ScreenAnnotationState, ScreenAnnotationTarget } from "@q9labsai/chalk-client";

export type AnnotationAuthor = ScreenAnnotationMark["author"];

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
  readonly fontUrl?: string;
  readonly helper?: ScreenAnnotationHelper;
}

export interface ScreenAnnotationSetup extends Pick<ScreenAnnotationOptions, "actions" | "fontUrl" | "helper"> {
  /** Returns the confirmed publication for this exact local track, not the last projection for its participant. */
  readonly localPublicationForTrack?: (track: MediaStreamTrack) => string | undefined;
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

export function videoMatchesTrack(video: HTMLVideoElement, track: MediaStreamTrack): boolean {
  const stream = video.srcObject;
  return track.readyState === "live" && !track.muted && stream instanceof MediaStream && stream.getVideoTracks().includes(track);
}

export function decodedSize(video: HTMLVideoElement | null): ScreenAnnotationFrameSize | null {
  return video && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && video.videoWidth > 0 && video.videoHeight > 0 ? { width: video.videoWidth, height: video.videoHeight } : null;
}

export interface ScreenAnnotationHelperShare {
  readonly client: ScreenAnnotationClient;
  readonly layer: ScreenAnnotationState["layer"];
  readonly participantId: string;
  readonly surface: "browser" | "window" | "monitor" | null;
}

export type ScreenAnnotationHelperStatus = "unbound" | "calibrating" | "ready" | "unsupported_surface" | "update_required" | "disconnected";

export interface ScreenAnnotationHelper {
  readonly installUrl?: string;
  readonly challenge?: (share: ScreenAnnotationHelperShare, signal: AbortSignal) => Promise<{ readonly kind: "update_required" } | { readonly kind: "approval"; readonly fingerprint: string; readonly attach: (onStatus: (status: ScreenAnnotationHelperStatus) => void) => Promise<void> }>;
  readonly lookupCode?: (
    code: string,
    share: ScreenAnnotationHelperShare,
    signal: AbortSignal,
  ) => Promise<{
    readonly deviceName: string;
    readonly approve: (onStatus: (status: ScreenAnnotationHelperStatus) => void) => Promise<void>;
  }>;
}
