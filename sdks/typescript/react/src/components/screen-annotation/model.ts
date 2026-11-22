import type { ScreenAnnotationActions as SharedActions, ScreenAnnotationFrame as SharedFrame } from "@q9labsai/chalk-screen-annotation";
import type { ChalkWhiteboardV1Transport, ScreenAnnotationClient, ScreenAnnotationDraft, ScreenAnnotationFrameSize, ScreenAnnotationMark, ScreenAnnotationState, ScreenAnnotationTarget, SpaceClient } from "@q9labsai/chalk-client";

export type AnnotationAuthor = ScreenAnnotationMark["author"];

export type ScreenAnnotationFrame = SharedFrame<HTMLCanvasElement>;
export type ScreenAnnotationActions = SharedActions<HTMLCanvasElement>;

export interface ScreenAnnotationOptions {
  readonly client: ScreenAnnotationClient;
  readonly publicationId: string;
  readonly actions?: ScreenAnnotationActions;
  readonly offerPngDownload?: boolean;
  readonly fontUrl?: string;
  readonly helper?: ScreenAnnotationHelper;
}

export type ScreenAnnotationSetup = Pick<ScreenAnnotationOptions, "actions" | "fontUrl" | "helper" | "offerPngDownload">;

export interface ScreenAnnotationBoard {
  readonly client: SpaceClient;
  readonly transport: ChalkWhiteboardV1Transport;
  readonly allowSave: boolean;
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

export type ScreenAnnotationHelperStatus = "waiting_for_sync" | "unbound" | "calibrating" | "ready" | "unsupported_surface" | "device_approved" | "update_required" | "disconnected";

export interface ScreenAnnotationHelper {
  readonly installUrl?: string;
  readonly challenge?: (
    share: ScreenAnnotationHelperShare,
    signal: AbortSignal,
  ) => Promise<{ readonly kind: "update_required" } | { readonly kind: "approval"; readonly fingerprint: string; readonly remembered?: boolean; readonly attach: (onStatus: (status: ScreenAnnotationHelperStatus) => void, confirm: (signal: AbortSignal) => Promise<string>) => Promise<void> }>;
  readonly deviceAccount?: string;
  readonly lookupCode?: (
    code: string,
    share: ScreenAnnotationHelperShare,
    signal: AbortSignal,
  ) => Promise<{
    readonly deviceName: string;
    readonly fingerprint?: string;
    readonly approve: (onStatus: (status: ScreenAnnotationHelperStatus) => void) => Promise<void>;
  }>;
}
