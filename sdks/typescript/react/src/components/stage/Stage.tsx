import React, { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";

import { usePrefersReducedMotion } from "../../internal/useMediaQuery";
import { cn } from "../../utils/cn";
import type { ParticipantGradientPreference } from "../../utils/colorGenerator";
import { ChalkSheet } from "../chalk-ui";
import { useStageDimensions } from "./useStageDimensions";
import { ParticipantTile } from "../participant-tile/ParticipantTile";
import { DEFAULT_GRID_OPTIONS, DEFAULT_SPOTLIGHT_OPTIONS, EMPTY_GEOMETRY, fitGrid, fitSpotlight, type StageBox, type StageFrame, type StageGeometry, MORE_TILE_ID } from "./stage-layout";
import { buildStageItems, choosePrimary, floatingSpeakerId, gridOrder, isContentItem, stabilizeOrder, type StageItem, type StageLayout } from "./stage-items";
import { StageMotion } from "./StageMotion";
import { StageContentTile, StageContentTileSurface } from "./StageContentTile";

export type { StageItem, StageLayout } from "./stage-items";

export interface StageTileRenderContext {
  readonly active: boolean;
  readonly primary: boolean;
  readonly pinned: boolean;
  readonly hidden: boolean;
  readonly style: CSSProperties | undefined;
  readonly onClick: (() => void) | undefined;
  readonly onDoubleClick: (() => void) | undefined;
}

export interface StageProps {
  readonly items: readonly StageItem[];
  readonly layout: StageLayout;
  /** Controlled pinned item; omit to let the stage manage pinning via tile clicks. */
  readonly pinnedId?: string | null;
  readonly onOverflowClick?: () => void;
  readonly onPinnedChange?: (id: string | null) => void;
  readonly onItemClick?: (item: StageItem) => void;
  readonly onItemDoubleClick?: (item: StageItem) => void;
  /** While the board is open, clicking a person follows their board view. */
  readonly followingId?: string | null;
  readonly onFollowChange?: (id: string) => void;
  readonly clickAction?: "pin" | "follow";
  /** Upper bound of visible tiles; the rest fold into a +N People tile. */
  readonly maxPerPage?: number;
  /** Tiles narrower than this fold the rest into overflow. */
  readonly minTileWidth?: number;
  /** Renders the focused screen share / whiteboard. Falls back to the unfocused card when omitted. */
  readonly renderPrimaryContent?: (item: Extract<StageItem, { kind: "screen-share" | "whiteboard" }>) => ReactNode;
  /** Presentation seam for camera media that is not a live MediaStreamTrack. */
  readonly renderParticipant?: (item: Extract<StageItem, { kind: "participant" }>, context: StageTileRenderContext) => ReactNode;
  /** Presentation seam for unfocused shared content that is not a live MediaStreamTrack. */
  readonly renderContentTile?: (item: Extract<StageItem, { kind: "screen-share" | "whiteboard" }>, context: StageTileRenderContext) => ReactNode;
  /** Removes local pinning and keyboard commands while preserving the same layout. */
  readonly interactive?: boolean;
  /** Overrides system motion preference for deterministic render profiles. */
  readonly animate?: boolean;
  /** Show generated Facehash avatars when Participants have no uploaded avatar. */
  readonly generatedAvatars?: boolean;
  readonly gradientPreference?: ParticipantGradientPreference;
  readonly emptyState?: ReactNode;
  readonly className?: string;
}

export { buildStageItems };

const FALLBACK_BOX: StageBox = { width: 960, height: 540 };
const TILE_FILL: CSSProperties = { width: "100%", height: "100%" };

function frameStyle(frame: StageFrame): CSSProperties {
  return { position: "absolute", left: 0, top: 0, transform: `translate(${frame.x}px, ${frame.y}px)`, width: frame.width, height: frame.height, zIndex: frame.role === "primary" ? 1 : 2 };
}

/**
 * Single renderer for every layout: a flat list of tiles positioned by the pure fitter, so
 * switching between grid and focus never remounts a video element.
 */
export function Stage({
  items,
  layout,
  pinnedId,
  followingId = null,
  onFollowChange,
  clickAction = "pin",
  onPinnedChange,
  onOverflowClick,
  onItemClick,
  onItemDoubleClick,
  maxPerPage = DEFAULT_GRID_OPTIONS.maxPerPage,
  minTileWidth = DEFAULT_GRID_OPTIONS.minTileWidth,
  renderPrimaryContent,
  renderParticipant,
  renderContentTile,
  interactive = true,
  animate: animateOverride,
  generatedAvatars = true,
  gradientPreference,
  emptyState,
  className,
}: StageProps): React.JSX.Element {
  const prefersReducedMotion = usePrefersReducedMotion();
  const { ref: boxRef, dimensions: box } = useStageDimensions(FALLBACK_BOX);
  const [overflowOpen, setOverflowOpen] = useState(false);
  const [shareAspects, setShareAspects] = useState<ReadonlyMap<string, number>>(new Map());
  const [uncontrolledPinnedId, setUncontrolledPinnedId] = useState<string | null>(null);
  const activePinnedId = pinnedId === undefined ? uncontrolledPinnedId : pinnedId;
  const orderRef = useRef<readonly string[]>([]);
  const seenAtRef = useRef(new Map<string, number>());
  const nextSeenRef = useRef(0);
  const lastSpeakerRef = useRef<string | null>(null);

  const ordered = useMemo(() => {
    // A presentation projection must be a pure function of its current frame.
    // Live stages retain visual order across roster changes, but doing that for
    // non-interactive renders would make a seek depend on prior rendered frames.
    if (!interactive) {
      seenAtRef.current = new Map(items.map((item, index) => [item.id, index]));
      nextSeenRef.current = items.length;
      return [...items];
    }
    // Departed ids are dropped so long calls don't retain every past guest; the
    // counter keeps growing so shares keep their arrival order.
    const seenAt = seenAtRef.current;
    const present = new Set(items.map((item) => item.id));
    for (const id of seenAt.keys()) if (!present.has(id)) seenAt.delete(id);
    for (const item of items) if (!seenAt.has(item.id)) seenAt.set(item.id, nextSeenRef.current++);
    return stabilizeOrder(orderRef.current, items);
  }, [interactive, items]);

  const handOrderRef = useRef<readonly string[]>([]);
  const handOrders = useMemo(() => {
    const raised = ordered.filter((item) => item.kind === "participant" && item.participant.isHandRaised).map((item) => item.id);
    const survivors = handOrderRef.current.filter((id) => raised.includes(id));
    const next = [...survivors, ...raised.filter((id) => !survivors.includes(id))];
    handOrderRef.current = next;
    return new Map(next.map((id, index) => [id, index + 1]));
  }, [ordered]);

  useEffect(() => {
    orderRef.current = ordered.map((item) => item.id);
    const speaking = ordered.find((item) => item.kind === "participant" && (item.participant.isActiveSpeaker || item.participant.isSpeaking));
    if (speaking) lastSpeakerRef.current = speaking.id;
  }, [ordered]);

  const primary = useMemo(() => (layout === "grid" ? null : choosePrimary(ordered, { layout, pinnedId: activePinnedId, lastSpeakerId: interactive ? lastSpeakerRef.current : null, seenAt: seenAtRef.current })), [activePinnedId, interactive, layout, ordered]);

  const geometry: StageGeometry = useMemo(() => {
    if (!ordered.length) return EMPTY_GEOMETRY;
    const wideIds = ordered.filter(isContentItem).map((item) => item.id);
    if (layout === "grid" || !primary) {
      const content = ordered.filter(isContentItem);
      const people = ordered.filter((item) => !isContentItem(item));
      const sorted = gridOrder([...content, ...people], activePinnedId);
      return fitGrid(
        box,
        sorted.map((item) => item.id),
        { ...DEFAULT_GRID_OPTIONS, maxPerPage, minTileWidth: box.width <= 640 ? 88 : minTileWidth, minTileHeight: box.width <= 640 ? 72 : 96 },
        wideIds,
      );
    }
    const track = primary.kind === "screen-share" ? primary.participant.screenShareTrack : null;
    const settings = track?.getSettings();
    const observedAspect = shareAspects.get(primary.id);
    const aspect = primary.kind === "whiteboard" ? null : (observedAspect ?? (primary.kind === "screen-share" && primary.participant.screenShareAspect ? primary.participant.screenShareAspect : settings?.width && settings.height ? settings.width / settings.height : 16 / 9));
    const remaining = ordered.filter((item) => item.id !== primary.id);
    const strip = [...remaining.filter(isContentItem), ...remaining.filter((item) => !isContentItem(item))];
    const speakerId = floatingSpeakerId(remaining, interactive ? lastSpeakerRef.current : null);
    const localId = remaining.find((item) => item.kind === "participant" && item.participant.isLocal)?.id ?? null;
    return fitSpotlight(
      box,
      primary.id,
      strip.map((item) => item.id),
      {
        ...DEFAULT_SPOTLIGHT_OPTIONS,
        primaryAspect: aspect,
        content: primary.kind !== "participant",
        floatingPhonePeople: primary.kind === "whiteboard",
        speakerId,
        localId,
        wideIds: primary.kind === "screen-share" ? ordered.filter((item) => item.kind === "whiteboard").map((item) => item.id) : wideIds,
        maxPerPage,
      },
    );
  }, [activePinnedId, box, interactive, layout, maxPerPage, minTileWidth, ordered, primary, shareAspects]);
  const framesById = useMemo(() => new Map(geometry.frames.map((frame) => [frame.id, frame])), [geometry.frames]);
  const animate = animateOverride ?? !prefersReducedMotion;
  const [displayed, setDisplayed] = useState<{ source: readonly StageItem[]; geometry: StageGeometry; tiles: readonly { item: StageItem; frame: StageFrame | undefined; leaving: boolean; departedAt?: number }[] }>({
    source: ordered,
    geometry,
    tiles: ordered.map((item) => ({ item, frame: framesById.get(item.id), leaving: false })),
  });
  if (displayed.source !== ordered || displayed.geometry !== geometry) {
    const present = new Set(ordered.map((item) => item.id));
    const tiles = ordered.map((item) => ({ item, frame: framesById.get(item.id), leaving: false }));
    setDisplayed({ source: ordered, geometry, tiles: [...tiles, ...(animate ? displayed.tiles.filter((tile) => !present.has(tile.item.id)).map((tile) => ({ ...tile, leaving: true, departedAt: tile.departedAt ?? performance.now() })) : [])] });
  }
  useEffect(() => {
    const departing = displayed.tiles.filter((tile) => tile.leaving);
    if (!departing.length) return;
    const nextExpiry = Math.min(...departing.map((tile) => (tile.departedAt ?? 0) + 160));
    const timer = setTimeout(() => setDisplayed((current) => ({ ...current, tiles: current.tiles.filter((tile) => !tile.leaving || (tile.departedAt ?? 0) + 160 > performance.now()) })), Math.max(0, nextExpiry - performance.now()));
    return () => clearTimeout(timer);
  }, [displayed]);
  const tilesRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const root = tilesRef.current;
    if (!root) return;
    const updateAspect = (event: Event) => {
      const video = event.target;
      if (!(video instanceof HTMLVideoElement) || !video.videoWidth || !video.videoHeight) return;
      const id = video.closest<HTMLElement>("[data-stage-item]")?.dataset.stageItem;
      if (!id || !ordered.some((item) => item.id === id && item.kind === "screen-share")) return;
      const aspect = video.videoWidth / video.videoHeight;
      setShareAspects((current) => (Math.abs((current.get(id) ?? 0) - aspect) < 0.001 ? current : new Map(current).set(id, aspect)));
    };
    root.addEventListener("loadedmetadata", updateAspect, true);
    root.addEventListener("resize", updateAspect, true);
    const present = new Set(ordered.filter(isContentItem).map((item) => item.id));
    setShareAspects((current) => ([...current.keys()].every((id) => present.has(id)) ? current : new Map([...current].filter(([id]) => present.has(id)))));
    return () => {
      root.removeEventListener("loadedmetadata", updateAspect, true);
      root.removeEventListener("resize", updateAspect, true);
    };
  }, [ordered]);
  const motionKey =
    displayed.tiles.map(({ item, frame, leaving }) => `${item.id}:${frame?.x},${frame?.y},${frame?.width},${frame?.height}:${leaving}`).join(";") +
    geometry.frames
      .filter((frame) => frame.id === MORE_TILE_ID)
      .map((frame) => `${frame.x},${frame.y},${frame.width},${frame.height}`)
      .join(";");

  const togglePin = useCallback(
    (item: StageItem) => {
      const next = activePinnedId === item.id && !(layout === "grid" && isContentItem(item)) ? null : item.id;
      if (pinnedId === undefined) setUncontrolledPinnedId(next);
      onPinnedChange?.(next);
    },
    [activePinnedId, layout, onPinnedChange, pinnedId],
  );

  const handlersById = useMemo(() => {
    const map = new Map<string, { onClick: () => void; onDoubleClick?: () => void }>();
    if (!interactive) return map;
    for (const item of ordered) {
      map.set(item.id, {
        onClick: () => {
          if (clickAction === "follow" && item.kind === "participant" && !item.participant.isLocal) onFollowChange?.(item.id);
          else togglePin(item);
          onItemClick?.(item);
        },
        onDoubleClick: onItemDoubleClick ? () => onItemDoubleClick(item) : undefined,
      });
    }
    return map;
  }, [clickAction, interactive, onFollowChange, onItemDoubleClick, onItemClick, ordered, togglePin]);

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
      <div ref={boxRef} className="relative h-full w-full outline-none" role="group" aria-label={`Stage with ${participantCount} ${participantCount === 1 ? "participant" : "participants"}`} aria-disabled={interactive ? undefined : true} data-testid="stage">
        <StageMotion rootRef={tilesRef} motionKey={motionKey} animate={animate}>
          {displayed.tiles.map(({ item, frame, leaving }) => {
            const onPage = Boolean(frame) && !leaving;
            const style = TILE_FILL;
            const pinned = activePinnedId === item.id;
            const handlers = handlersById.get(item.id);
            const click = handlers?.onClick;
            const doubleClick = handlers?.onDoubleClick;
            const renderContext: StageTileRenderContext = { active: onPage, primary: frame?.role === "primary", pinned, hidden: !frame, style, onClick: click, onDoubleClick: doubleClick };
            let content: ReactNode;
            if (item.kind === "participant") {
              content = renderParticipant ? (
                renderParticipant(item, renderContext)
              ) : (
                <ParticipantTile
                  participant={item.participant.isHandRaised ? { ...item.participant, handRaiseOrder: handOrders.size > 1 ? (item.participant.handRaiseOrder ?? handOrders.get(item.id)) : undefined } : item.participant}
                  videoTrack={frame ? item.participant.videoTrack : null}
                  aspectRatio="fill"
                  primary={frame?.role === "primary"}
                  pinned={pinned}
                  clickAction={item.participant.isLocal ? "pin" : clickAction}
                  following={followingId === item.id}
                  onClick={click}
                  onDoubleClick={doubleClick}
                  style={style}
                  hidden={!frame}
                  generatedAvatars={generatedAvatars}
                  gradientPreference={gradientPreference}
                />
              );
            } else if (frame?.role === "primary" && renderPrimaryContent) {
              content = <StageContentTileSurface item={item} {...renderContext} mediaVisible media={renderPrimaryContent(item)} />;
            } else if (renderContentTile) {
              content = renderContentTile(item, renderContext);
            } else if (renderPrimaryContent) {
              content = <StageContentTileSurface item={item} {...renderContext} mediaVisible media={renderPrimaryContent(item)} />;
            } else {
              content = <StageContentTile item={item} {...renderContext} />;
            }
            return (
              <div
                key={item.id}
                data-stage-item={item.id}
                data-stage-role={frame?.role}
                data-pinned={pinned || undefined}
                aria-hidden={!frame || undefined}
                inert={!onPage ? true : undefined}
                data-leaving={leaving || undefined}
                style={frame ? { ...frameStyle(frame), pointerEvents: leaving ? "none" : undefined } : { display: "none" }}
              >
                {content}
              </div>
            );
          })}
          {geometry.frames
            .filter((frame) => frame.id === MORE_TILE_ID)
            .map((frame) => (
              <button
                key={frame.id}
                type="button"
                data-stage-item={MORE_TILE_ID}
                style={frameStyle(frame)}
                onClick={onOverflowClick ?? (() => setOverflowOpen(true))}
                disabled={!interactive}
                aria-label={`Show ${geometry.overflowCount} more participants`}
                className="grid place-items-center rounded-[12px] bg-[var(--chalk-raised)] text-[22px] font-semibold text-[var(--chalk-text)] hover:bg-[var(--chalk-hover)] max-[640px]:rounded-[14px]"
              >
                +{geometry.overflowCount}
              </button>
            ))}
        </StageMotion>
      </div>
      <ChalkSheet open={overflowOpen} onOpenChange={setOverflowOpen} title="People">
        {ordered
          .filter((item) => item.kind === "participant")
          .map((item) => (
            <button
              key={item.id}
              type="button"
              className="min-h-11 w-full rounded-xl px-4 text-left hover:bg-[var(--chalk-hover)]"
              onClick={() => {
                handlersById.get(item.id)?.onClick();
                setOverflowOpen(false);
              }}
            >
              {clickAction === "follow" && !item.participant.isLocal ? `${followingId === item.id ? "Stop following" : "Follow"} ` : ""}
              {item.participant.displayName}
              {item.participant.isMuted ? " · Muted" : ""}
            </button>
          ))}
      </ChalkSheet>
    </div>
  );
}

Stage.displayName = "Stage";

export function stageHasContent(items: readonly StageItem[]): boolean {
  return items.some(isContentItem);
}
