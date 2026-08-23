import React, { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";

import { usePrefersReducedMotion } from "../../internal/useMediaQuery";
import { cn } from "../../utils/cn";
import type { ParticipantGradientPreference } from "../../utils/colorGenerator";
import { useResizeObserver } from "../chalk-ui/useResizeObserver";
import { ParticipantTile } from "../participant-tile/ParticipantTile";
import { DEFAULT_GRID_OPTIONS, DEFAULT_SPOTLIGHT_OPTIONS, EMPTY_GEOMETRY, fitGrid, fitSpotlight, type StageBox, type StageFrame, type StageGeometry } from "./stage-layout";
import { buildStageItems, choosePrimary, gridOrder, isContentItem, stabilizeOrder, type StageItem, type StageLayout } from "./stage-items";
import { StageContentTile } from "./StageContentTile";
import { StagePager } from "./StagePager";

export type { StageItem, StageLayout } from "./stage-items";

export interface StageProps {
  readonly items: readonly StageItem[];
  readonly layout: StageLayout;
  /** Controlled pinned item; omit to let the stage manage pinning via tile clicks. */
  readonly pinnedId?: string | null;
  readonly onPinnedChange?: (id: string | null) => void;
  readonly onItemClick?: (item: StageItem) => void;
  readonly onItemDoubleClick?: (item: StageItem) => void;
  /** Upper bound of tiles per grid page; the fitter may use fewer when tiles would get too small. */
  readonly maxPerPage?: number;
  /** Tiles narrower than this push the rest to another page. */
  readonly minTileWidth?: number;
  /** Renders the focused screen share / whiteboard. Falls back to the unfocused card when omitted. */
  readonly renderPrimaryContent?: (item: Extract<StageItem, { kind: "screen-share" | "whiteboard" }>) => ReactNode;
  /** Show generated Facehash avatars when Participants have no uploaded avatar. */
  readonly generatedAvatars?: boolean;
  readonly gradientPreference?: ParticipantGradientPreference;
  readonly emptyState?: ReactNode;
  readonly className?: string;
}

export { buildStageItems };

/** Height reserved beneath the tiles for the page dots when there is more than one page. */
const PAGER_BAND = 22;
/** Padding inside the clipping box so tile corners and rings are never cut by the stage edge. */
const STAGE_INSET_CLASS = "p-1";

const FALLBACK_BOX: StageBox = { width: 960, height: 540 };
const TRANSITION = "transform 300ms cubic-bezier(0.2, 0, 0, 1), width 300ms cubic-bezier(0.2, 0, 0, 1), height 300ms cubic-bezier(0.2, 0, 0, 1)";

function frameStyle(frame: StageFrame, currentPage: number, stride: number, animate: boolean): CSSProperties {
  const offset = frame.role === "primary" ? 0 : currentPage * stride;
  return {
    position: "absolute",
    top: 0,
    left: 0,
    width: frame.width,
    height: frame.height,
    transform: `translate3d(${frame.x - offset}px, ${frame.y}px, 0)`,
    transition: animate ? TRANSITION : undefined,
    willChange: "transform",
    zIndex: frame.role === "primary" ? 1 : 2,
  };
}

/**
 * Single renderer for every layout: a flat list of tiles positioned by the pure fitter, so
 * switching between grid, focus and presentation never remounts a video element.
 */
export function Stage({ items, layout, pinnedId, onPinnedChange, onItemClick, onItemDoubleClick, maxPerPage = DEFAULT_GRID_OPTIONS.maxPerPage, minTileWidth = DEFAULT_GRID_OPTIONS.minTileWidth, renderPrimaryContent, generatedAvatars = true, gradientPreference, emptyState, className }: StageProps): React.JSX.Element {
  const prefersReducedMotion = usePrefersReducedMotion();
  const { ref: boxRef, dimensions: box } = useResizeObserver<HTMLDivElement>(FALLBACK_BOX);
  const [uncontrolledPinnedId, setUncontrolledPinnedId] = useState<string | null>(null);
  const activePinnedId = pinnedId === undefined ? uncontrolledPinnedId : pinnedId;
  const [page, setPage] = useState(0);
  const orderRef = useRef<readonly string[]>([]);
  const seenAtRef = useRef(new Map<string, number>());
  const lastSpeakerRef = useRef<string | null>(null);

  const ordered = useMemo(() => {
    const seenAt = seenAtRef.current;
    for (const item of items) if (!seenAt.has(item.id)) seenAt.set(item.id, seenAt.size);
    return stabilizeOrder(orderRef.current, items);
  }, [items]);

  useEffect(() => {
    orderRef.current = ordered.map((item) => item.id);
    const speaking = ordered.find((item) => item.kind === "participant" && (item.participant.isActiveSpeaker || item.participant.isSpeaking));
    if (speaking) lastSpeakerRef.current = speaking.id;
  }, [ordered]);

  useEffect(() => setPage(0), [layout]);

  const primary = useMemo(() => (layout === "grid" ? null : choosePrimary(ordered, { layout, pinnedId: activePinnedId, lastSpeakerId: lastSpeakerRef.current, seenAt: seenAtRef.current })), [activePinnedId, layout, ordered]);

  const geometry: StageGeometry = useMemo(() => {
    if (ordered.length === 0) return EMPTY_GEOMETRY;
    const fit = (target: StageBox): StageGeometry => {
      if (layout === "grid" || !primary) {
        return fitGrid(
          target,
          gridOrder(ordered, activePinnedId).map((item) => item.id),
          { ...DEFAULT_GRID_OPTIONS, maxPerPage, minTileWidth },
        );
      }
      return fitSpotlight(
        target,
        primary.id,
        ordered.filter((item) => item.id !== primary.id).map((item) => item.id),
        DEFAULT_SPOTLIGHT_OPTIONS,
      );
    };
    const full = fit(box);
    // A shorter box never fits more per page, so paging stays on and the pager gets its own band.
    return full.pageCount > 1 ? fit({ width: box.width, height: Math.max(0, box.height - PAGER_BAND) }) : full;
  }, [activePinnedId, box, layout, maxPerPage, minTileWidth, ordered, primary]);

  const currentPage = Math.min(page, Math.max(0, geometry.pageCount - 1));
  const stride = box.width + DEFAULT_GRID_OPTIONS.gap;
  const framesById = useMemo(() => new Map(geometry.frames.map((frame) => [frame.id, frame])), [geometry.frames]);

  const animate = !prefersReducedMotion;

  const togglePin = useCallback(
    (item: StageItem) => {
      const next = activePinnedId === item.id ? null : item.id;
      if (pinnedId === undefined) setUncontrolledPinnedId(next);
      onPinnedChange?.(next);
    },
    [activePinnedId, onPinnedChange, pinnedId],
  );

  // Stable per-tile props: without these, every Stage render (speaker flips,
  // roster deltas, resize) rebuilds style objects and closures and defeats
  // React.memo on ParticipantTile/StageContentTile.
  const stylesById = useMemo(() => {
    const map = new Map<string, CSSProperties>();
    for (const frame of geometry.frames) map.set(frame.id, frameStyle(frame, currentPage, stride, animate));
    return map;
  }, [animate, currentPage, geometry.frames, stride]);

  const handlersById = useMemo(() => {
    const map = new Map<string, { onClick: () => void; onDoubleClick?: () => void }>();
    for (const item of ordered) {
      map.set(item.id, {
        onClick: () => {
          togglePin(item);
          onItemClick?.(item);
        },
        onDoubleClick: onItemDoubleClick ? () => onItemDoubleClick(item) : undefined,
      });
    }
    return map;
  }, [onItemDoubleClick, onItemClick, ordered, togglePin]);

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (geometry.pageCount <= 1 || event.target !== event.currentTarget) return;
      if (event.key === "ArrowRight") setPage((current) => Math.min(current + 1, geometry.pageCount - 1));
      if (event.key === "ArrowLeft") setPage((current) => Math.max(current - 1, 0));
    },
    [geometry.pageCount],
  );

  if (ordered.length === 0) {
    return (
      <div className={cn("flex h-full w-full items-center justify-center px-6 py-10", className)} data-tour="video-grid">
        {emptyState}
      </div>
    );
  }

  const participantCount = ordered.filter((item) => item.kind === "participant").length;

  return (
    <div className={cn("relative h-full w-full", className)} data-tour="video-grid">
      <div
        ref={boxRef}
        className={cn("relative h-full w-full overflow-hidden outline-none focus-visible:ring-2 focus-visible:ring-[var(--chalk-focus)]", STAGE_INSET_CLASS)}
        role="group"
        aria-label={`Stage with ${participantCount} ${participantCount === 1 ? "participant" : "participants"}`}
        tabIndex={geometry.pageCount > 1 ? 0 : undefined}
        onKeyDown={handleKeyDown}
        data-testid="stage"
      >
        <div className="relative h-full w-full">
          {ordered.map((item) => {
            const frame = framesById.get(item.id);
            if (!frame) return null;
            const onPage = frame.role === "primary" || frame.page === currentPage;
            const style = stylesById.get(item.id);
            const pinned = activePinnedId === item.id;
            const handlers = handlersById.get(item.id);
            const click = handlers?.onClick;
            const doubleClick = handlers?.onDoubleClick;
            if (item.kind === "participant") {
              return <ParticipantTile key={item.id} participant={item.participant} videoTrack={onPage ? item.participant.videoTrack : null} aspectRatio="fill" pinned={pinned} onClick={click} onDoubleClick={doubleClick} style={style} hidden={!onPage} generatedAvatars={generatedAvatars} gradientPreference={gradientPreference} />;
            }
            if (frame.role === "primary" && renderPrimaryContent) {
              return (
                <div key={item.id} style={style} className="overflow-hidden rounded-[8px]" data-testid="stage-primary-content">
                  {renderPrimaryContent(item)}
                </div>
              );
            }
            return <StageContentTile key={item.id} item={item} active={onPage} pinned={pinned} onClick={click} onDoubleClick={doubleClick} style={style} hidden={!onPage} />;
          })}
        </div>
      </div>
      {geometry.pageCount > 1 ? <StagePager page={currentPage} pageCount={geometry.pageCount} onPageChange={setPage} arrowsCenterY={pagedBandCenter(geometry)} dotsHeight={PAGER_BAND} /> : null}
    </div>
  );
}

Stage.displayName = "Stage";

/** Vertical centre (px from the top of the stage) of the tiles that page: the strip in spotlight, everything in grid. */
function pagedBandCenter(geometry: StageGeometry): number | null {
  const paged = geometry.frames.filter((frame) => frame.role !== "primary");
  if (paged.length === 0) return null;
  const top = Math.min(...paged.map((frame) => frame.y));
  const bottom = Math.max(...paged.map((frame) => frame.y + frame.height));
  return (top + bottom) / 2;
}

export function stageHasContent(items: readonly StageItem[]): boolean {
  return items.some(isContentItem);
}
