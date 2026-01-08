import React, { useMemo } from 'react';
import { cn } from '../../utils/cn';
import { VideoTile } from '../atomic';

export interface Participant {
  id: string;
  displayName: string;
  isLocal?: boolean;
  isSpeaking?: boolean;
  isMuted?: boolean;
  isVideoEnabled?: boolean;
  isScreenSharing?: boolean;
  isHandRaised?: boolean;
  connectionQuality?: 0 | 1 | 2 | 3 | 4;
  avatarUrl?: string;
  videoTrack?: MediaStreamTrack | null;
  screenShareTrack?: MediaStreamTrack | null;
  screenShareAudioTrack?: MediaStreamTrack | null;
}

export interface VideoGridProps {
  participants: Participant[];
  layout?: 'grid' | 'spotlight' | 'sidebar' | 'screen-share';
  pinnedParticipantId?: string;
  onParticipantClick?: (participantId: string) => void;
  onParticipantDoubleClick?: (participantId: string) => void;
  maxVisibleParticipants?: number;
  className?: string;
  showScreenShareIndicator?: boolean;
}

export const VideoGrid = React.memo(({
  participants,
  layout = 'grid',
  pinnedParticipantId,
  onParticipantClick,
  onParticipantDoubleClick,
  maxVisibleParticipants = 25,
  className,
  showScreenShareIndicator: _showScreenShareIndicator = true,
}: VideoGridProps) => {
  // Note: screenSharer and effectiveLayout reserved for future screen-share layout feature

  const sortedParticipants = useMemo(() => {
    const sorted = [...participants];
    if (pinnedParticipantId) {
      const pinnedIndex = sorted.findIndex((p) => p.id === pinnedParticipantId);
      if (pinnedIndex !== -1 && sorted[pinnedIndex]) {
        const pinned = sorted[pinnedIndex]!;
        sorted.splice(pinnedIndex, 1);
        sorted.unshift(pinned);
      }
    }
    return sorted;
  }, [participants, pinnedParticipantId]);

  const visibleParticipants = sortedParticipants.slice(0, maxVisibleParticipants);
  const overflowCount = participants.length - visibleParticipants.length;

  const getGridClass = (count: number) => {
    if (count <= 1) return 'grid-cols-1';
    if (count <= 2) return 'grid-cols-1 sm:grid-cols-2';
    if (count <= 4) return 'grid-cols-2';
    if (count <= 6) return 'grid-cols-2 sm:grid-cols-3';
    if (count <= 9) return 'grid-cols-3';
    return 'grid-cols-2 sm:grid-cols-3 md:grid-cols-4';
  };

  const mapToVideoTileParticipant = (p: Participant | undefined) => {
    if (!p) {
      return {
        id: 'unknown',
        displayName: 'Unknown',
      };
    }
    return {
      id: p.id,
      displayName: p.displayName,
      isLocal: p.isLocal,
      isSpeaking: p.isSpeaking,
      isMuted: p.isMuted,
      isVideoEnabled: p.isVideoEnabled,
      isScreenSharing: p.isScreenSharing,
      isHandRaised: p.isHandRaised,
      connectionQuality: (p.connectionQuality && p.connectionQuality > 0) ? (p.connectionQuality as 1 | 2 | 3 | 4) : undefined,
      avatarUrl: p.avatarUrl,
    };
  };

  if (layout === 'spotlight') {
    const mainParticipant = visibleParticipants[0];
    const otherParticipants = visibleParticipants.slice(1);

    return (
      <div 
        className={cn("flex flex-col h-full gap-4", className)}
        data-tour="video-grid"
      >
        <div className="flex-1 min-h-0 relative rounded-lg overflow-hidden bg-[var(--chalk-bg-secondary)] border border-[var(--chalk-border-subtle)]">
          {mainParticipant && (
            <VideoTile
              participant={mapToVideoTileParticipant(mainParticipant)}
              videoTrack={mainParticipant.videoTrack}
              onClick={() => onParticipantClick?.(mainParticipant.id)}
              onDoubleClick={() => onParticipantDoubleClick?.(mainParticipant.id)}
              className="w-full h-full"
            />
          )}
        </div>
        
        {otherParticipants.length > 0 && (
          <div className="h-32 flex gap-4 overflow-x-auto pb-2 px-1">
            {otherParticipants.map((p) => (
              <div key={p.id} className="w-48 flex-shrink-0 aspect-video rounded-lg overflow-hidden relative border border-[var(--chalk-border-subtle)]">
                <VideoTile
                  participant={mapToVideoTileParticipant(p)}
                  videoTrack={p.videoTrack}
                  onClick={() => onParticipantClick?.(p.id)}
                  onDoubleClick={() => onParticipantDoubleClick?.(p.id)}
                  className="w-full h-full"
                  showName={false}
                />
              </div>
            ))}
            {overflowCount > 0 && (
              <div className="w-48 flex-shrink-0 aspect-video rounded-lg bg-[var(--chalk-bg-secondary)] border border-[var(--chalk-border-subtle)] flex items-center justify-center text-[var(--chalk-text-muted)]">
                +{overflowCount} more
              </div>
            )}
          </div>
        )}
      </div>
    );
  }

  if (layout === 'sidebar') {
    const mainParticipant = visibleParticipants[0];
    const otherParticipants = visibleParticipants.slice(1);

    return (
      <div 
        className={cn("flex h-full gap-4", className)}
        data-tour="video-grid"
      >
        <div className="flex-1 relative rounded-lg overflow-hidden bg-[var(--chalk-bg-secondary)] border border-[var(--chalk-border-subtle)]">
          {mainParticipant && (
            <VideoTile
              participant={mapToVideoTileParticipant(mainParticipant)}
              videoTrack={mainParticipant.videoTrack}
              onClick={() => onParticipantClick?.(mainParticipant.id)}
              onDoubleClick={() => onParticipantDoubleClick?.(mainParticipant.id)}
              className="w-full h-full"
            />
          )}
        </div>
        
        <div className="w-64 flex flex-col gap-2 overflow-y-auto pl-1 pr-2">
          {otherParticipants.map((p) => (
            <div key={p.id} className="w-full aspect-video rounded-lg overflow-hidden relative border border-[var(--chalk-border-subtle)] flex-shrink-0">
              <VideoTile
                participant={mapToVideoTileParticipant(p)}
                videoTrack={p.videoTrack}
                onClick={() => onParticipantClick?.(p.id)}
                onDoubleClick={() => onParticipantDoubleClick?.(p.id)}
                className="w-full h-full"
                showName={false}
              />
            </div>
          ))}
           {overflowCount > 0 && (
              <div className="w-full aspect-video rounded-lg bg-[var(--chalk-bg-secondary)] border border-[var(--chalk-border-subtle)] flex items-center justify-center text-[var(--chalk-text-muted)] flex-shrink-0">
                +{overflowCount} more
              </div>
            )}
        </div>
      </div>
    );
  }

  return (
    <div 
      className={cn(
        "grid gap-4 w-full h-full overflow-y-auto p-1",
        getGridClass(visibleParticipants.length),
        className
      )}
      data-tour="video-grid"
    >
      {visibleParticipants.map((p) => (
        <div 
          key={p.id} 
          className="relative rounded-lg overflow-hidden border border-[var(--chalk-border-subtle)] bg-[var(--chalk-bg-secondary)] aspect-video"
        >
          <VideoTile
            participant={mapToVideoTileParticipant(p)}
            videoTrack={p.videoTrack}
            onClick={() => onParticipantClick?.(p.id)}
            onDoubleClick={() => onParticipantDoubleClick?.(p.id)}
            className="w-full h-full"
          />
        </div>
      ))}
      {overflowCount > 0 && (
         <div className="relative rounded-lg overflow-hidden border border-[var(--chalk-border-subtle)] bg-[var(--chalk-bg-secondary)] aspect-video flex items-center justify-center">
            <span className="text-xl font-medium text-[var(--chalk-text-muted)]">+{overflowCount} more</span>
         </div>
      )}
    </div>
  );
});

VideoGrid.displayName = 'VideoGrid';
