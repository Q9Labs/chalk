import React, { useCallback, useMemo, useRef, useState } from "react";
import { cn } from "../../utils/cn";
import { UserGroupIcon } from "../../utils/icons";
import { ParticipantTile } from "../atomic";
import { useIsMobile } from "../../internal/useMediaQuery";

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

export interface ParticipantGridProps {
  participants: Participant[];
  layout?: "grid" | "focus" | "presentation";
  /** Mobile variant auto-selects optimal layout based on participant count */
  variant?: "desktop" | "mobile";
  pinnedParticipantId?: string;
  onParticipantClick?: (participantId: string) => void;
  onParticipantDoubleClick?: (participantId: string) => void;
  maxVisibleParticipants?: number;
  className?: string;
  showScreenShareIndicator?: boolean;
  /** Optional preview or app-owned surface when no real screen-share track is available. */
  screenShareContent?: React.ReactNode;
}

export const ParticipantGrid = React.memo(({ participants, layout = "grid", variant, pinnedParticipantId, onParticipantClick, onParticipantDoubleClick, maxVisibleParticipants = 25, className, showScreenShareIndicator: _showScreenShareIndicator = true, screenShareContent }: ParticipantGridProps) => {
  const isMobile = useIsMobile();
  const effectiveVariant = variant ?? (isMobile ? "mobile" : "desktop");
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
  const mobileMaxVisible = effectiveVariant === "mobile" ? Math.min(maxVisibleParticipants, 6) : maxVisibleParticipants;
  const visibleParticipants = sortedParticipants.slice(0, mobileMaxVisible);
  const overflowCount = participants.length - visibleParticipants.length;

  const getPrimaryParticipant = useCallback((candidateParticipants: Participant[]) => candidateParticipants.find((participant) => !participant.isLocal && participant.isSpeaking) ?? candidateParticipants.find((participant) => !participant.isLocal) ?? candidateParticipants[0], []);

  const getGridLayout = (count: number) => {
    if (count <= 1) return { cols: "grid-cols-1", rows: "grid-rows-1" };
    if (count === 2) return { cols: "grid-cols-2", rows: "grid-rows-1" };
    if (count === 3) return { cols: "grid-cols-3", rows: "grid-rows-1" };
    if (count === 4) return { cols: "grid-cols-2", rows: "grid-rows-2" };
    if (count === 5) return { cols: "grid-cols-6", rows: "grid-rows-2" };
    if (count === 6) return { cols: "grid-cols-3", rows: "grid-rows-2" };
    if (count === 7) return { cols: "grid-cols-12", rows: "grid-rows-3" };
    if (count === 8) return { cols: "grid-cols-12", rows: "grid-rows-3" };
    if (count === 9) return { cols: "grid-cols-3", rows: "grid-rows-3" };
    if (count === 10) return { cols: "grid-cols-12", rows: "grid-rows-3" };
    if (count === 11) return { cols: "grid-cols-12", rows: "grid-rows-3" };
    if (count === 12) return { cols: "grid-cols-4", rows: "grid-rows-3" };
    if (count <= 16) return { cols: "grid-cols-4", rows: "grid-rows-4" };
    if (count <= 20) return { cols: "grid-cols-5", rows: "grid-rows-4" };
    return { cols: "grid-cols-5", rows: "grid-rows-5" };
  };

  const getGridItemClass = (count: number, index: number) => {
    if (count === 5) return index < 3 ? "col-span-2" : "col-span-3";
    if (count === 7) return index < 3 ? "col-span-4" : "col-span-6"; // 3, 2, 2
    if (count === 8) return index < 6 ? "col-span-4" : "col-span-6"; // 3, 3, 2
    if (count === 10) return index < 4 ? "col-span-3" : "col-span-4"; // 4, 3, 3
    if (count === 11) return index < 8 ? "col-span-3" : "col-span-4"; // 4, 4, 3
    return "col-span-1";
  };

  // Stagger tile entrances, capped so large grids settle quickly
  const getTileDelay = (index: number) => `${Math.min(index * 60, 480)}ms`;

  const mapToVideoTileParticipant = (p: Participant | undefined) => {
    if (!p) {
      return {
        id: "unknown",
        displayName: "Unknown",
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
      connectionQuality: p.connectionQuality && p.connectionQuality > 0 ? (p.connectionQuality as 1 | 2 | 3 | 4) : undefined,
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
      behavior: "smooth",
    });

    touchStartRef.current = null;
  }, [totalPages]);

  const goToPage = useCallback((index: number) => {
    if (!carouselRef.current) return;
    const containerWidth = carouselRef.current.offsetWidth;
    setCarouselIndex(index);
    carouselRef.current.scrollTo({
      left: index * containerWidth,
      behavior: "smooth",
    });
  }, []);

  if (participants.length === 0) {
    return (
      <div className={cn("flex h-full w-full items-center justify-center px-6 py-10", className)} data-tour="video-grid" role="status" aria-live="polite" aria-atomic="true">
        <div className="flex w-full max-w-sm flex-col items-center rounded-[14px] border border-dashed border-[var(--chalk-app-line-strong)] bg-[var(--chalk-app-panel)] px-7 py-10 text-center shadow-[var(--chalk-app-shadow-xs)] sm:px-10">
          <div aria-hidden="true" className="mb-5 grid h-12 w-12 place-items-center rounded-full bg-[var(--chalk-app-control)] text-[var(--chalk-app-text-muted)]">
            <UserGroupIcon size={24} />
          </div>
          <h2 className="text-xl font-semibold tracking-[-0.02em] text-[var(--chalk-app-text)]">The Space is quiet</h2>
          <p className="mt-2 text-sm leading-6 text-[var(--chalk-app-text-muted)]">No other Participants are here yet.</p>
        </div>
      </div>
    );
  }

  // ============================================
  // MOBILE LAYOUTS
  // ============================================
  if (effectiveVariant === "mobile") {
    const count = visibleParticipants.length;

    // Mobile: 1 participant - Full bleed
    if (count === 1) {
      const p = visibleParticipants[0]!;
      return (
        <div className={cn("h-full w-full", className)} data-tour="video-grid">
          <ParticipantTile participant={mapToVideoTileParticipant(p)} videoTrack={p.videoTrack} onClick={() => onParticipantClick?.(p.id)} onDoubleClick={() => onParticipantDoubleClick?.(p.id)} aspectRatio="fill" className="w-full h-full" />
        </div>
      );
    }

    // Mobile: 2 participants - Vertical stack (50/50)
    if (count === 2) {
      return (
        <div className={cn("flex flex-col h-full w-full gap-1", className)} data-tour="video-grid">
          {visibleParticipants.map((p) => (
            <div key={p.id} className="flex-1 min-h-0">
              <ParticipantTile participant={mapToVideoTileParticipant(p)} videoTrack={p.videoTrack} onClick={() => onParticipantClick?.(p.id)} onDoubleClick={() => onParticipantDoubleClick?.(p.id)} aspectRatio="fill" className="w-full h-full" />
            </div>
          ))}
        </div>
      );
    }

    // Mobile: 3-4 participants - 2x2 grid
    if (count <= 4) {
      return (
        <div className={cn("grid grid-cols-2 grid-rows-2 h-full w-full gap-1", className)} data-tour="video-grid">
          {visibleParticipants.map((p) => (
            <ParticipantTile key={p.id} participant={mapToVideoTileParticipant(p)} videoTrack={p.videoTrack} onClick={() => onParticipantClick?.(p.id)} onDoubleClick={() => onParticipantDoubleClick?.(p.id)} aspectRatio="fill" className="w-full h-full" />
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
        <div ref={carouselRef} className="flex-1 min-h-0 overflow-x-auto snap-x snap-mandatory scrollbar-hide" style={{ scrollbarWidth: "none", msOverflowStyle: "none" }} onTouchStart={handleTouchStart} onTouchMove={handleTouchMove} onTouchEnd={handleTouchEnd}>
          <div className="flex h-full" style={{ width: `${pages.length * 100}%` }}>
            {pages.map((page, pageIndex) => (
              <div key={pageIndex} className="grid grid-cols-2 grid-rows-2 gap-1 snap-center" style={{ width: `${100 / pages.length}%` }}>
                {page.map((p) => (
                  <ParticipantTile key={p.id} participant={mapToVideoTileParticipant(p)} videoTrack={p.videoTrack} onClick={() => onParticipantClick?.(p.id)} onDoubleClick={() => onParticipantDoubleClick?.(p.id)} aspectRatio="fill" className="w-full h-full" />
                ))}
                {/* Fill empty slots in last page */}
                {pageIndex === pages.length - 1 && page.length < 4 && Array.from({ length: 4 - page.length }).map((_, i) => <div key={`empty-${i}`} className="rounded-lg bg-[var(--chalk-app-tile-base)]" />)}
              </div>
            ))}
          </div>
        </div>

        {/* Page indicators */}
        {pages.length > 1 && (
          <div className="flex justify-center gap-1.5 py-2">
            {pages.map((_, i) => (
              <button key={i} type="button" onClick={() => goToPage(i)} className={cn("h-2 w-2 rounded-full bg-[var(--chalk-app-control)] transition-all", i === carouselIndex && "w-4")} aria-label={`Go to page ${i + 1}`} />
            ))}
          </div>
        )}

        {/* Overflow indicator */}
        {overflowCount > 0 && <div className="pb-1 text-center text-xs text-[var(--chalk-app-text)]">+{overflowCount} more</div>}
      </div>
    );
  }

  // ============================================
  // DESKTOP LAYOUTS (existing code)
  // ============================================

  if (layout === "focus") {
    const mainParticipant = getPrimaryParticipant(visibleParticipants);
    const otherParticipants = visibleParticipants.filter((participant) => participant.id !== mainParticipant?.id);

    return (
      <div className={cn("flex h-full flex-col gap-3", className)} data-tour="video-grid">
        <div className="flex-1 min-h-0 relative">
          {mainParticipant && <ParticipantTile participant={mapToVideoTileParticipant(mainParticipant)} videoTrack={mainParticipant.videoTrack} onClick={() => onParticipantClick?.(mainParticipant.id)} onDoubleClick={() => onParticipantDoubleClick?.(mainParticipant.id)} className="w-full h-full" />}
        </div>

        {otherParticipants.length > 0 && (
          <div className="flex h-[clamp(120px,20vh,168px)] gap-3 overflow-x-auto">
            {otherParticipants.map((p) => (
              <div key={p.id} className="h-full aspect-video flex-shrink-0">
                <ParticipantTile participant={mapToVideoTileParticipant(p)} videoTrack={p.videoTrack} onClick={() => onParticipantClick?.(p.id)} onDoubleClick={() => onParticipantDoubleClick?.(p.id)} className="w-full h-full" showName={true} />
              </div>
            ))}
            {overflowCount > 0 && <div className="flex h-full aspect-video flex-shrink-0 items-center justify-center rounded-2xl bg-[var(--chalk-app-tile-base)] text-[var(--chalk-app-text-muted)]">+{overflowCount} more</div>}
          </div>
        )}
      </div>
    );
  }

  // Presentation layout: content fills main area, participants in right filmstrip
  if (layout === "presentation") {
    const screenSharer = visibleParticipants.find((p) => p.isScreenSharing);
    const primaryParticipant = screenSharer ?? getPrimaryParticipant(visibleParticipants);
    const otherParticipants = visibleParticipants.filter((p) => p.id !== primaryParticipant?.id);

    return (
      <div className={cn("flex h-full gap-2", className)} data-tour="video-grid">
        <div className="relative min-w-0 flex-1 overflow-hidden rounded-[8px] bg-[var(--chalk-app-tile-base)]">
          {screenShareContent ??
            (primaryParticipant && (
              <ParticipantTile
                participant={mapToVideoTileParticipant(primaryParticipant)}
                videoTrack={primaryParticipant.screenShareTrack || primaryParticipant.videoTrack}
                onClick={() => onParticipantClick?.(primaryParticipant.id)}
                onDoubleClick={() => onParticipantDoubleClick?.(primaryParticipant.id)}
                className="w-full h-full"
                aspectRatio="16:9"
              />
            ))}
        </div>

        {otherParticipants.length > 0 && (
          <div className="w-64 flex flex-col gap-2 overflow-y-auto">
            {otherParticipants.map((p) => (
              <div key={p.id} className="w-full aspect-video flex-shrink-0">
                <ParticipantTile participant={mapToVideoTileParticipant(p)} videoTrack={p.videoTrack} onClick={() => onParticipantClick?.(p.id)} onDoubleClick={() => onParticipantDoubleClick?.(p.id)} className="w-full h-full" showName={true} />
              </div>
            ))}
            {overflowCount > 0 && <div className="flex w-full aspect-video flex-shrink-0 items-center justify-center rounded-2xl bg-[var(--chalk-app-tile-base)] text-[var(--chalk-app-text-muted)]">+{overflowCount} more</div>}
          </div>
        )}
      </div>
    );
  }

  // Default grid layout
  const totalGridItems = visibleParticipants.length + (overflowCount > 0 ? 1 : 0);
  const gridLayout = getGridLayout(totalGridItems);

  // Single participant: full bleed with minimal padding
  if (visibleParticipants.length === 1 && overflowCount === 0) {
    const p = visibleParticipants[0]!;
    return (
      <div className={cn("h-full w-full flex items-center justify-center", className)} data-tour="video-grid">
        <ParticipantTile participant={mapToVideoTileParticipant(p)} videoTrack={p.videoTrack} onClick={() => onParticipantClick?.(p.id)} onDoubleClick={() => onParticipantDoubleClick?.(p.id)} className="w-full h-full" />
      </div>
    );
  }

  return (
    <div className={cn("grid gap-2 w-full h-full place-items-center", gridLayout.cols, gridLayout.rows, className)} data-tour="video-grid">
      {visibleParticipants.map((p, index) => (
        <ParticipantTile
          key={p.id}
          participant={mapToVideoTileParticipant(p)}
          videoTrack={p.videoTrack}
          onClick={() => onParticipantClick?.(p.id)}
          onDoubleClick={() => onParticipantDoubleClick?.(p.id)}
          pinned={p.id === pinnedParticipantId}
          aspectRatio="fill"
          className={cn("w-full h-full max-h-full chalk-animate-tile-pop", getGridItemClass(totalGridItems, index))}
          style={{ animationDelay: getTileDelay(index) }}
        />
      ))}
      {overflowCount > 0 && (
        <div className={cn("flex h-full w-full items-center justify-center rounded-2xl bg-[var(--chalk-app-tile-base)] chalk-animate-tile-pop", getGridItemClass(totalGridItems, visibleParticipants.length))} style={{ animationDelay: getTileDelay(visibleParticipants.length) }}>
          <span className="text-[var(--chalk-app-text-muted)] text-xl font-medium">+{overflowCount} more</span>
        </div>
      )}
    </div>
  );
});

ParticipantGrid.displayName = "ParticipantGrid";
