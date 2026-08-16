import React, { useCallback, useMemo, useRef, useState } from "react";
import { useMedia, useParticipants, useSelf } from "../../bindings/hooks";
import { cn } from "../../utils/cn";
import { UserGroupIcon } from "../../utils/icons";
import { ParticipantTile } from "../atomic";
import { ChalkBadge, ChalkControlGroup, ChalkEmptyState, ChalkIconButton, ChalkPanel } from "../chalk-ui";
import { useIsMobile } from "../../internal/useMediaQuery";
import { toVideoParticipants } from "../../selectors/space-selectors";

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

interface ParticipantGridSurfaceProps extends ParticipantGridProps {
  readonly participants: Participant[];
}

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

const ParticipantGridSurface = React.memo(
  ({ participants, layout = "grid", variant, pinnedParticipantId, onParticipantClick, onParticipantDoubleClick, maxVisibleParticipants = 25, className, showScreenShareIndicator: _showScreenShareIndicator = true, screenShareContent }: ParticipantGridSurfaceProps) => {
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
        <div className={cn("flex h-full w-full items-center justify-center px-6 py-10", className)} data-tour="video-grid">
          <ChalkEmptyState className="w-full max-w-sm px-7 py-10 sm:px-10" title="The Space is quiet" description="No other Participants are here yet." aria-live="polite" aria-atomic="true">
            <ChalkBadge aria-hidden="true" tone="neutral" className="mx-auto mb-5 size-12 min-h-0 min-w-0 p-0 text-[var(--chalk-app-text-muted)]">
              <UserGroupIcon size={24} />
            </ChalkBadge>
          </ChalkEmptyState>
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
        <div className={cn("relative flex h-full min-w-0 w-full flex-col", className)} data-tour="video-grid">
          {/* Carousel container */}
          <div
            ref={carouselRef}
            data-testid="participant-grid-carousel"
            className="min-h-0 min-w-0 flex-1 snap-x snap-mandatory overflow-x-auto overscroll-x-contain scrollbar-hide"
            style={{ scrollbarWidth: "none", msOverflowStyle: "none" }}
            onTouchStart={handleTouchStart}
            onTouchMove={handleTouchMove}
            onTouchEnd={handleTouchEnd}
          >
            <div className="flex h-full min-w-0" style={{ width: `${pages.length * 100}%` }}>
              {pages.map((page, pageIndex) => (
                <div key={pageIndex} data-testid="participant-grid-page" className="grid h-full min-w-0 shrink-0 snap-center grid-cols-2 grid-rows-2 gap-1" style={{ width: `${100 / pages.length}%` }}>
                  {page.map((p) => (
                    <ParticipantTile key={p.id} participant={mapToVideoTileParticipant(p)} videoTrack={p.videoTrack} onClick={() => onParticipantClick?.(p.id)} onDoubleClick={() => onParticipantDoubleClick?.(p.id)} aspectRatio="fill" className="w-full h-full" />
                  ))}
                  {/* Fill empty slots in last page */}
                  {pageIndex === pages.length - 1 && page.length < 4 && Array.from({ length: 4 - page.length }).map((_, i) => <ChalkPanel key={`empty-${i}`} aria-hidden="true" filled={false} className="rounded-lg p-0" />)}
                </div>
              ))}
            </div>
          </div>

          {/* Page indicators */}
          {pages.length > 1 && (
            <ChalkPanel className="pointer-events-auto absolute bottom-16 left-1/2 z-40 -translate-x-1/2 rounded-full p-1" role="group" aria-label="Participant pages">
              <ChalkControlGroup className="gap-0.5" role="presentation">
                {pages.map((_, i) => (
                  <ChalkIconButton
                    key={i}
                    size="sm"
                    tone={i === carouselIndex ? "accent" : "neutral"}
                    type="button"
                    onClick={() => goToPage(i)}
                    className="rounded-full p-0 focus-visible:ring-2 focus-visible:ring-[var(--chalk-app-control-active-line)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--chalk-app-stage)]"
                    aria-label={`Go to page ${i + 1}`}
                    aria-current={i === carouselIndex ? "page" : undefined}
                    seed={`participant-page-${i}`}
                  >
                    <span aria-hidden="true" className={cn("block h-2 w-2 rounded-full bg-[var(--chalk-app-line-strong)] transition-all", i === carouselIndex && "w-4 bg-[var(--chalk-app-control-active-line)]")} />
                  </ChalkIconButton>
                ))}
              </ChalkControlGroup>
            </ChalkPanel>
          )}

          {/* Overflow indicator */}
          {overflowCount > 0 && (
            <ChalkBadge tone="neutral" className="mx-auto mb-1 text-center text-xs">
              +{overflowCount} more
            </ChalkBadge>
          )}
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
            {mainParticipant && (
              <ParticipantTile participant={mapToVideoTileParticipant(mainParticipant)} videoTrack={mainParticipant.videoTrack} onClick={() => onParticipantClick?.(mainParticipant.id)} onDoubleClick={() => onParticipantDoubleClick?.(mainParticipant.id)} className="w-full h-full" />
            )}
          </div>

          {otherParticipants.length > 0 && (
            <div className="flex h-[clamp(120px,20vh,168px)] gap-3 overflow-x-auto">
              {otherParticipants.map((p) => (
                <div key={p.id} className="h-full aspect-video flex-shrink-0">
                  <ParticipantTile participant={mapToVideoTileParticipant(p)} videoTrack={p.videoTrack} onClick={() => onParticipantClick?.(p.id)} onDoubleClick={() => onParticipantDoubleClick?.(p.id)} className="w-full h-full" showName={true} />
                </div>
              ))}
              {overflowCount > 0 && (
                <ChalkPanel tone="neutral" className="flex h-full aspect-video flex-shrink-0 items-center justify-center rounded-2xl p-0 text-[var(--chalk-app-text-muted)]">
                  +{overflowCount} more
                </ChalkPanel>
              )}
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
          <ChalkPanel tone="neutral" filled className="relative min-w-0 flex-1 overflow-hidden rounded-[8px] p-0 [&>div]:h-full [&>div]:w-full">
            <div className="relative h-full">
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
          </ChalkPanel>

          {otherParticipants.length > 0 && (
            <div className="w-64 flex flex-col gap-2 overflow-y-auto">
              {otherParticipants.map((p) => (
                <div key={p.id} className="w-full aspect-video flex-shrink-0">
                  <ParticipantTile participant={mapToVideoTileParticipant(p)} videoTrack={p.videoTrack} onClick={() => onParticipantClick?.(p.id)} onDoubleClick={() => onParticipantDoubleClick?.(p.id)} className="w-full h-full" showName={true} />
                </div>
              ))}
              {overflowCount > 0 && (
                <ChalkPanel tone="neutral" className="flex w-full aspect-video flex-shrink-0 items-center justify-center rounded-2xl p-0 text-[var(--chalk-app-text-muted)]">
                  +{overflowCount} more
                </ChalkPanel>
              )}
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
          <ParticipantTile participant={mapToVideoTileParticipant(p)} videoTrack={p.videoTrack} onClick={() => onParticipantClick?.(p.id)} onDoubleClick={() => onParticipantDoubleClick?.(p.id)} aspectRatio="fill" className="h-full w-full" />
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
          <ChalkPanel tone="neutral" className={cn("flex h-full w-full items-center justify-center rounded-2xl p-0 chalk-animate-tile-pop", getGridItemClass(totalGridItems, visibleParticipants.length))} style={{ animationDelay: getTileDelay(visibleParticipants.length) }}>
            <span className="text-[var(--chalk-app-text-muted)] text-xl font-medium">+{overflowCount} more</span>
          </ChalkPanel>
        )}
      </div>
    );
  },
);

ParticipantGridSurface.displayName = "ParticipantGridSurface";

ParticipantGrid.displayName = "ParticipantGrid";
