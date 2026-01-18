import React, { useCallback, useMemo, useRef, useState } from 'react';
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
  /** Mobile variant auto-selects optimal layout based on participant count */
  variant?: 'desktop' | 'mobile';
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
  variant = 'desktop',
  pinnedParticipantId,
  onParticipantClick,
  onParticipantDoubleClick,
  maxVisibleParticipants = 25,
  className,
  showScreenShareIndicator: _showScreenShareIndicator = true,
}: VideoGridProps) => {
  // Carousel state for mobile 5+ participants
  const [carouselIndex, setCarouselIndex] = useState(0);
  const touchStartRef = useRef<{ x: number; scrollLeft: number } | null>(null);
  const carouselRef = useRef<HTMLDivElement>(null);

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

  // Mobile limits visible participants more aggressively
  const mobileMaxVisible = variant === 'mobile' ? Math.min(maxVisibleParticipants, 6) : maxVisibleParticipants;
  const visibleParticipants = sortedParticipants.slice(0, mobileMaxVisible);
  const overflowCount = participants.length - visibleParticipants.length;

  const getGridLayout = (count: number) => {
    if (count <= 1) return { cols: 'grid-cols-1', rows: '' };
    if (count === 2) return { cols: 'grid-cols-2', rows: '' };
    if (count === 3) return { cols: 'grid-cols-3', rows: '' };
    if (count === 4) return { cols: 'grid-cols-2', rows: 'grid-rows-2' };
    if (count <= 6) return { cols: 'grid-cols-3', rows: 'grid-rows-2' };
    if (count <= 9) return { cols: 'grid-cols-3', rows: 'grid-rows-3' };
    return { cols: 'grid-cols-4', rows: '' };
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

  // Carousel navigation for mobile 5+ participants
  const totalPages = Math.ceil(visibleParticipants.length / 4);

  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    const touch = e.touches[0];
    if (!touch || !carouselRef.current) return;
    touchStartRef.current = { x: touch.clientX, scrollLeft: carouselRef.current.scrollLeft };
  }, []);

  const handleTouchMove = useCallback((e: React.TouchEvent) => {
    if (!touchStartRef.current || !carouselRef.current) return;
    const touch = e.touches[0];
    if (!touch) return;
    const deltaX = touchStartRef.current.x - touch.clientX;
    carouselRef.current.scrollLeft = touchStartRef.current.scrollLeft + deltaX;
  }, []);

  const handleTouchEnd = useCallback(() => {
    if (!touchStartRef.current || !carouselRef.current) return;
    const containerWidth = carouselRef.current.offsetWidth;
    const currentScroll = carouselRef.current.scrollLeft;
    const newIndex = Math.round(currentScroll / containerWidth);
    const clampedIndex = Math.max(0, Math.min(newIndex, totalPages - 1));

    setCarouselIndex(clampedIndex);
    carouselRef.current.scrollTo({
      left: clampedIndex * containerWidth,
      behavior: 'smooth',
    });

    touchStartRef.current = null;
  }, [totalPages]);

  const goToPage = useCallback((index: number) => {
    if (!carouselRef.current) return;
    const containerWidth = carouselRef.current.offsetWidth;
    setCarouselIndex(index);
    carouselRef.current.scrollTo({
      left: index * containerWidth,
      behavior: 'smooth',
    });
  }, []);

  // ============================================
  // MOBILE LAYOUTS
  // ============================================
  if (variant === 'mobile') {
    const count = visibleParticipants.length;

    // Mobile: 1 participant - Full bleed
    if (count === 1) {
      const p = visibleParticipants[0]!;
      return (
        <div className={cn("h-full w-full", className)} data-tour="video-grid">
          <VideoTile
            participant={mapToVideoTileParticipant(p)}
            videoTrack={p.videoTrack}
            onClick={() => onParticipantClick?.(p.id)}
            onDoubleClick={() => onParticipantDoubleClick?.(p.id)}
            aspectRatio="fill"
            className="w-full h-full"
          />
        </div>
      );
    }

    // Mobile: 2 participants - Vertical stack (50/50)
    if (count === 2) {
      return (
        <div
          className={cn("flex flex-col h-full w-full gap-1", className)}
          data-tour="video-grid"
        >
          {visibleParticipants.map((p) => (
            <div key={p.id} className="flex-1 min-h-0">
              <VideoTile
                participant={mapToVideoTileParticipant(p)}
                videoTrack={p.videoTrack}
                onClick={() => onParticipantClick?.(p.id)}
                onDoubleClick={() => onParticipantDoubleClick?.(p.id)}
                aspectRatio="fill"
                className="w-full h-full"
              />
            </div>
          ))}
        </div>
      );
    }

    // Mobile: 3-4 participants - 2x2 grid
    if (count <= 4) {
      return (
        <div
          className={cn("grid grid-cols-2 grid-rows-2 h-full w-full gap-1", className)}
          data-tour="video-grid"
        >
          {visibleParticipants.map((p) => (
            <VideoTile
              key={p.id}
              participant={mapToVideoTileParticipant(p)}
              videoTrack={p.videoTrack}
              onClick={() => onParticipantClick?.(p.id)}
              onDoubleClick={() => onParticipantDoubleClick?.(p.id)}
              aspectRatio="fill"
              className="w-full h-full"
            />
          ))}
        </div>
      );
    }

    // Mobile: 5+ participants - Swipeable carousel with 2x2 pages
    const pages: Participant[][] = [];
    for (let i = 0; i < visibleParticipants.length; i += 4) {
      pages.push(visibleParticipants.slice(i, i + 4));
    }

    return (
      <div className={cn("flex flex-col h-full w-full", className)} data-tour="video-grid">
        {/* Carousel container */}
        <div
          ref={carouselRef}
          className="flex-1 min-h-0 overflow-x-auto snap-x snap-mandatory scrollbar-hide"
          style={{ scrollbarWidth: 'none', msOverflowStyle: 'none' }}
          onTouchStart={handleTouchStart}
          onTouchMove={handleTouchMove}
          onTouchEnd={handleTouchEnd}
        >
          <div className="flex h-full" style={{ width: `${pages.length * 100}%` }}>
            {pages.map((page, pageIndex) => (
              <div
                key={pageIndex}
                className="grid grid-cols-2 grid-rows-2 gap-1 snap-center"
                style={{ width: `${100 / pages.length}%` }}
              >
                {page.map((p) => (
                  <VideoTile
                    key={p.id}
                    participant={mapToVideoTileParticipant(p)}
                    videoTrack={p.videoTrack}
                    onClick={() => onParticipantClick?.(p.id)}
                    onDoubleClick={() => onParticipantDoubleClick?.(p.id)}
                    aspectRatio="fill"
                    className="w-full h-full"
                  />
                ))}
                {/* Fill empty slots in last page */}
                {pageIndex === pages.length - 1 && page.length < 4 && (
                  Array.from({ length: 4 - page.length }).map((_, i) => (
                    <div
                      key={`empty-${i}`}
                      className="rounded-lg bg-[var(--chalk-bg-tile)]"
                    />
                  ))
                )}
              </div>
            ))}
          </div>
        </div>

        {/* Page indicators */}
        {pages.length > 1 && (
          <div className="flex justify-center gap-1.5 py-2">
            {pages.map((_, i) => (
              <button
                key={i}
                type="button"
                onClick={() => goToPage(i)}
                className={cn(
                  "w-2 h-2 rounded-full transition-all",
                  i === carouselIndex
                    ? "bg-white w-4"
                    : "bg-white/40"
                )}
                aria-label={`Go to page ${i + 1}`}
              />
            ))}
          </div>
        )}

        {/* Overflow indicator */}
        {overflowCount > 0 && (
          <div className="text-center text-xs text-white/60 pb-1">
            +{overflowCount} more
          </div>
        )}
      </div>
    );
  }

  // ============================================
  // DESKTOP LAYOUTS (existing code)
  // ============================================

  if (layout === 'spotlight') {
    const mainParticipant = visibleParticipants[0];
    const otherParticipants = visibleParticipants.slice(1);

    return (
      <div
        className={cn("flex flex-col h-full gap-1", className)}
        data-tour="video-grid"
      >
        <div className="flex-1 min-h-0 relative">
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
          <div className="h-28 flex gap-1 overflow-x-auto">
            {otherParticipants.map((p) => (
              <div key={p.id} className="w-44 flex-shrink-0">
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
              <div className="w-44 flex-shrink-0 aspect-video rounded-[var(--chalk-border-radius-lg)] bg-[var(--chalk-bg-tile)] flex items-center justify-center text-[var(--chalk-text-muted)]">
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
        className={cn("flex h-full gap-1", className)}
        data-tour="video-grid"
      >
        <div className="flex-1 relative">
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
          <div className="w-48 flex flex-col gap-1 overflow-y-auto">
            {otherParticipants.map((p) => (
              <div key={p.id} className="w-full aspect-video flex-shrink-0">
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
              <div className="w-full aspect-video rounded-[var(--chalk-border-radius-lg)] bg-[var(--chalk-bg-tile)] flex items-center justify-center text-[var(--chalk-text-muted)] flex-shrink-0">
                +{overflowCount} more
              </div>
            )}
          </div>
        )}
      </div>
    );
  }

  // Screen-share layout: content fills main area, participants in right filmstrip
  if (layout === 'screen-share') {
    const screenSharer = visibleParticipants.find((p) => p.isScreenSharing);
    const otherParticipants = visibleParticipants.filter((p) => p.id !== screenSharer?.id);

    return (
      <div
        className={cn("flex h-full gap-1", className)}
        data-tour="video-grid"
      >
        <div className="flex-1 relative">
          {screenSharer && (
            <VideoTile
              participant={mapToVideoTileParticipant(screenSharer)}
              videoTrack={screenSharer.screenShareTrack || screenSharer.videoTrack}
              onClick={() => onParticipantClick?.(screenSharer.id)}
              onDoubleClick={() => onParticipantDoubleClick?.(screenSharer.id)}
              className="w-full h-full"
              aspectRatio="16:9"
            />
          )}
        </div>

        {otherParticipants.length > 0 && (
          <div className="w-48 flex flex-col gap-1 overflow-y-auto">
            {otherParticipants.map((p) => (
              <div key={p.id} className="w-full aspect-video flex-shrink-0">
                <VideoTile
                  participant={mapToVideoTileParticipant(p)}
                  videoTrack={p.videoTrack}
                  onClick={() => onParticipantClick?.(p.id)}
                  onDoubleClick={() => onParticipantDoubleClick?.(p.id)}
                  className="w-full h-full"
                  showName
                />
              </div>
            ))}
            {overflowCount > 0 && (
              <div className="w-full aspect-video rounded-[var(--chalk-border-radius-lg)] bg-[var(--chalk-bg-tile)] flex items-center justify-center text-[var(--chalk-text-muted)] flex-shrink-0">
                +{overflowCount} more
              </div>
            )}
          </div>
        )}
      </div>
    );
  }

  // Default grid layout
  const gridLayout = getGridLayout(visibleParticipants.length);

  // Single participant: full bleed
  if (visibleParticipants.length === 1) {
    const p = visibleParticipants[0]!;
    return (
      <div className={cn("h-full w-full flex items-center justify-center p-8", className)} data-tour="video-grid">
        <VideoTile
          participant={mapToVideoTileParticipant(p)}
          videoTrack={p.videoTrack}
          onClick={() => onParticipantClick?.(p.id)}
          onDoubleClick={() => onParticipantDoubleClick?.(p.id)}
          className="w-full h-full max-w-[90%] max-h-[85vh] shadow-2xl"
        />
      </div>
    );
  }

  return (
    <div
      className={cn(
        "grid gap-4 w-full h-full place-items-center p-4",
        gridLayout.cols,
        gridLayout.rows,
        className
      )}
      data-tour="video-grid"
    >
      {visibleParticipants.map((p) => (
        <VideoTile
          key={p.id}
          participant={mapToVideoTileParticipant(p)}
          videoTrack={p.videoTrack}
          onClick={() => onParticipantClick?.(p.id)}
          onDoubleClick={() => onParticipantDoubleClick?.(p.id)}
          pinned={p.id === pinnedParticipantId}
          className="w-full h-full max-h-full"
        />
      ))}
      {overflowCount > 0 && (
        <div className="rounded-[var(--chalk-border-radius-lg)] bg-[var(--chalk-bg-tile)] aspect-video flex items-center justify-center w-full h-full">
          <span className="text-xl font-medium text-[var(--chalk-text-muted)]">+{overflowCount} more</span>
        </div>
      )}
    </div>
  );
});

VideoGrid.displayName = 'VideoGrid';
