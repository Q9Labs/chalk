import React, { useMemo } from "react";
import { useMedia, useParticipants, useSelf } from "../../bindings/hooks";
import { UserGroupIcon } from "../../utils/icons";
import { ChalkBadge, ChalkEmptyState } from "../chalk-ui";
import { useIsMobile } from "../../internal/useMediaQuery";
import { toVideoParticipants } from "../../selectors/space-selectors";
import { Stage } from "../stage/Stage";
import { buildStageItems, type StageItem } from "../stage/stage-items";

export interface Participant {
  id: string;
  displayName: string;
  isLocal?: boolean;
  /** Voice activity for this participant, from sync presence. */
  isSpeaking?: boolean;
  /** The single loudest participant right now, from sync presence. */
  isActiveSpeaker?: boolean;
  isMuted?: boolean;
  /** Camera on. Screen sharing is reported separately via `isScreenSharing`. */
  isVideoEnabled?: boolean;
  isScreenSharing?: boolean;
  isHandRaised?: boolean;
  connectionQuality?: 0 | 1 | 2 | 3 | 4;
  avatarUrl?: string;
  videoTrack?: MediaStreamTrack | null;
  screenShareTrack?: MediaStreamTrack | null;
  screenShareAudioTrack?: MediaStreamTrack | null;
}

export interface ParticipantGridProps {
  layout?: "grid" | "focus" | "presentation";
  /** Mobile variant allows narrower tiles; defaults from the viewport. */
  variant?: "desktop" | "mobile";
  pinnedParticipantId?: string;
  onParticipantClick?: (participantId: string) => void;
  onParticipantDoubleClick?: (participantId: string) => void;
  /** Upper bound of tiles on a grid page; further participants go to the next page. */
  maxVisibleParticipants?: number;
  className?: string;
  /** Keeps the classic screen-share indicator available to callers; Chalk renders it in the stage tile. */
  showScreenShareIndicator?: boolean;
  /** Optional preview or app-owned surface when no real screen-share track is available. */
  screenShareContent?: React.ReactNode;
}

const MIN_TILE_WIDTH = { desktop: 160, mobile: 140 } as const;

/** Stage of participant tiles for the current Space; screen shares appear as their own tiles. */
export function ParticipantGrid(props: ParticipantGridProps): React.JSX.Element {
  const self = useSelf();
  const participantsSlice = useParticipants();
  const media = useMedia();
  const localId = self.participantId ?? "local";
  const participants = useMemo(() => {
    const hasLocalPresence = Boolean(self.participantId || self.displayName || Object.values(media.local).some((track) => track.state !== "disabled"));
    return hasLocalPresence ? toVideoParticipants(participantsSlice.roster, media.remote, localId, self.displayName ?? "You", media.local) : [];
  }, [localId, media.local, media.remote, participantsSlice.roster, self.displayName, self.participantId]);

  return <ParticipantGridSurface {...props} participants={participants} />;
}

interface ParticipantGridSurfaceProps extends ParticipantGridProps {
  readonly participants: readonly Participant[];
}

export const ParticipantGridSurface = React.memo(function ParticipantGridSurface({ participants, layout = "grid", variant, pinnedParticipantId, onParticipantClick, onParticipantDoubleClick, maxVisibleParticipants, className, screenShareContent }: ParticipantGridSurfaceProps) {
  const isMobile = useIsMobile();
  const effectiveVariant = variant ?? (isMobile ? "mobile" : "desktop");
  const items = useMemo(() => buildStageItems(participants, false), [participants]);

  return (
    <Stage
      items={items}
      layout={layout}
      pinnedId={pinnedParticipantId}
      onItemClick={onParticipantClick ? (item) => forwardParticipant(item, onParticipantClick) : undefined}
      onItemDoubleClick={onParticipantDoubleClick ? (item) => forwardParticipant(item, onParticipantDoubleClick) : undefined}
      maxPerPage={maxVisibleParticipants}
      minTileWidth={MIN_TILE_WIDTH[effectiveVariant]}
      renderPrimaryContent={screenShareContent ? (item) => (item.kind === "screen-share" ? screenShareContent : undefined) : undefined}
      className={className}
      emptyState={<QuietSpace />}
    />
  );
});

function forwardParticipant(item: StageItem, handler: (participantId: string) => void): void {
  if (item.kind === "whiteboard") return;
  handler(item.participant.id);
}

/** Empty stage message shared by the participant grid and the space views. */
export function QuietSpace(): React.JSX.Element {
  return (
    <ChalkEmptyState className="w-full max-w-sm px-7 py-10 sm:px-10" title="The Space is quiet" description="No other Participants are here yet." aria-live="polite" aria-atomic="true">
      <ChalkBadge aria-hidden="true" tone="neutral" className="mx-auto mb-5 size-12 min-h-0 min-w-0 p-0 text-[var(--chalk-app-text-muted)]">
        <UserGroupIcon size={24} />
      </ChalkBadge>
    </ChalkEmptyState>
  );
}

ParticipantGrid.displayName = "ParticipantGrid";
