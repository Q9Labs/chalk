import type { ParticipantState } from "@q9labs/chalk-core";

type RoomParticipant = ParticipantState["participants"][number];

export const NATIVE_COMPACT_VIEWPORT_MAX_WIDTH = 768;
export const NATIVE_COMPACT_GRID_PAGE_SIZE = 4;

export type NativeMeetingPrimaryContent = "grid" | "screen-share" | "screen-share-placeholder" | "whiteboard" | "split";

export interface NativeScreenShareStateLike {
  isActive: boolean;
  isLocalSharing: boolean;
  sharerParticipantId: string | null;
  videoTrack: MediaStreamTrack | null;
}

export interface ResolveNativeMeetingLayoutOptions {
  participants: readonly RoomParticipant[];
  localParticipant: RoomParticipant | null;
  screenShare: NativeScreenShareStateLike;
  isWhiteboardOpen: boolean;
  isCompactViewport: boolean;
}

export interface ResolvedNativeMeetingLayout {
  allParticipants: readonly RoomParticipant[];
  gridPages: readonly (readonly RoomParticipant[])[];
  primaryContent: NativeMeetingPrimaryContent;
  isStageMode: boolean;
  isSplit: boolean;
  showScreenShare: boolean;
  isCompactViewport: boolean;
  screenSharer: RoomParticipant | null;
  screenShareTrack: MediaStreamTrack | null;
  isLocalScreenShare: boolean;
}

function isSameParticipant(a: RoomParticipant | null, b: RoomParticipant | null): boolean {
  return Boolean(a && b && a.id === b.id);
}

export function isRenderableTrack(track: MediaStreamTrack | null | undefined): track is MediaStreamTrack {
  if (!track) {
    return false;
  }

  const readyState = "readyState" in track ? track.readyState : undefined;
  return readyState == null || readyState === "live";
}

export function normalizeStageParticipants(participants: readonly RoomParticipant[], localParticipant: RoomParticipant | null): RoomParticipant[] {
  const seen = new Set<string>();
  const normalized: RoomParticipant[] = [];

  if (localParticipant) {
    normalized.push(localParticipant);
    seen.add(localParticipant.id);
  }

  for (const participant of participants) {
    if (seen.has(participant.id)) {
      continue;
    }

    normalized.push(participant);
    seen.add(participant.id);
  }

  return normalized;
}

export function buildCompactParticipantPages(participants: readonly RoomParticipant[], pageSize = NATIVE_COMPACT_GRID_PAGE_SIZE): RoomParticipant[][] {
  if (participants.length === 0) {
    return [];
  }

  const pages: RoomParticipant[][] = [];
  for (let index = 0; index < participants.length; index += pageSize) {
    pages.push(participants.slice(index, index + pageSize));
  }
  return pages;
}

export function resolveScreenShareSource(
  participants: readonly RoomParticipant[],
  localParticipant: RoomParticipant | null,
  screenShare: NativeScreenShareStateLike,
): {
  screenSharer: RoomParticipant | null;
  screenShareTrack: MediaStreamTrack | null;
  isLocalScreenShare: boolean;
  showScreenShare: boolean;
} {
  const sharerById = screenShare.sharerParticipantId ? (participants.find((participant) => participant.id === screenShare.sharerParticipantId) ?? (localParticipant?.id === screenShare.sharerParticipantId ? localParticipant : null)) : null;
  const localIsSharer = screenShare.isLocalSharing || isSameParticipant(sharerById, localParticipant);
  const fallbackTrack = sharerById?.screenShareTrack ?? null;
  const screenShareTrack = isRenderableTrack(screenShare.videoTrack) ? screenShare.videoTrack : isRenderableTrack(fallbackTrack) ? fallbackTrack : null;
  const screenSharer = sharerById ?? (localIsSharer ? localParticipant : null);

  return {
    screenSharer,
    screenShareTrack,
    isLocalScreenShare: Boolean(localIsSharer && screenShareTrack),
    showScreenShare: Boolean(screenShare.isActive && screenShareTrack),
  };
}

export function resolveNativeMeetingLayout({ participants, localParticipant, screenShare, isWhiteboardOpen, isCompactViewport }: ResolveNativeMeetingLayoutOptions): ResolvedNativeMeetingLayout {
  const allParticipants = normalizeStageParticipants(participants, localParticipant);
  const gridPages = buildCompactParticipantPages(allParticipants);
  const { screenSharer, screenShareTrack, isLocalScreenShare, showScreenShare } = resolveScreenShareSource(participants, localParticipant, screenShare);
  const isSplit = !isCompactViewport && isWhiteboardOpen && showScreenShare;

  let primaryContent: NativeMeetingPrimaryContent = "grid";
  if (isSplit) {
    primaryContent = "split";
  } else if (isWhiteboardOpen) {
    primaryContent = "whiteboard";
  } else if (showScreenShare) {
    primaryContent = isLocalScreenShare ? "screen-share-placeholder" : "screen-share";
  }

  return {
    allParticipants,
    gridPages,
    primaryContent,
    isStageMode: primaryContent !== "grid",
    isSplit,
    showScreenShare,
    isCompactViewport,
    screenSharer,
    screenShareTrack,
    isLocalScreenShare,
  };
}
