import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMedia, useParticipants, useSelf, useSpaceClient } from "../../bindings/hooks";
import { cn } from "../../utils/cn";
import { ArrowDown01Icon, ArrowLeft01Icon, ArrowRight01Icon, ArrowUp01Icon, Maximize01Icon, Monitor01Icon, RefreshIcon, ZoomInIcon, ZoomOutIcon } from "../../utils/icons";
import { ParticipantTile } from "../atomic";
import { ChalkBadge, ChalkButton, ChalkControlGroup, ChalkDivider, ChalkEmptyState, ChalkIconButton, ChalkPanel, ChalkSpinner } from "../chalk-ui";
import { useSkin } from "../skin-context";
import { ClassicScreenShareView } from "./ClassicScreenShareView";
import type { Participant } from "../participant-grid/ParticipantGrid";
import { observeFirstRenderedFrame } from "../../internal/episode-diagnostic-render-observer";
import { toVideoParticipants } from "../../selectors/space-selectors";

export interface ScreenShareViewProps {
  onStopShare?: () => void;
  showThumbnails?: boolean;
  thumbnailPosition?: "bottom" | "right";
  enableZoom?: boolean;
  className?: string;
}

export interface ScreenShareViewSurfaceProps extends ScreenShareViewProps {
  readonly screenShareTrack: MediaStreamTrack;
  readonly sharedByName: string;
  readonly participants: Participant[];
}

const MIN_ZOOM = 1;
const MAX_ZOOM = 4;
const ZOOM_STEP = 0.5;

const getContainedSize = (containerWidth: number, containerHeight: number, videoWidth: number, videoHeight: number) => {
  if (!containerWidth || !containerHeight || !videoWidth || !videoHeight) {
    return {
      width: containerWidth,
      height: containerHeight,
    };
  }

  const containerRatio = containerWidth / containerHeight;
  const videoRatio = videoWidth / videoHeight;

  if (videoRatio > containerRatio) {
    return {
      width: containerWidth,
      height: containerWidth / videoRatio,
    };
  }

  return {
    width: containerHeight * videoRatio,
    height: containerHeight,
  };
};

export const ScreenShareViewSurface = React.memo(({ screenShareTrack, sharedByName, participants, onStopShare, showThumbnails = true, thumbnailPosition = "bottom", enableZoom = true, className }: ScreenShareViewSurfaceProps) => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Loading state
  const [isLoading, setIsLoading] = useState(true);

  // Sidebar/Thumbnails state
  const [isThumbnailsOpen, setIsThumbnailsOpen] = useState(true);

  // Rotation state
  const [rotation, setRotation] = useState(0);
  const [containerSize, setContainerSize] = useState({ width: 0, height: 0 });
  const [videoSize, setVideoSize] = useState({ width: 0, height: 0 });

  // Zoom state
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const dragStart = useRef({ x: 0, y: 0, panX: 0, panY: 0 });

  useEffect(() => {
    const videoEl = videoRef.current;
    if (!videoEl || !screenShareTrack) return;

    if (screenShareTrack.readyState === "ended") {
      return;
    }

    setIsLoading(true);

    try {
      const stream = new MediaStream([screenShareTrack]);
      videoEl.srcObject = stream;
      videoEl.play().catch(() => {
        // Play failed - may be user interaction required
      });
    } catch {
      // Failed to create MediaStream
    }

    return () => {
      videoEl.srcObject = null;
    };
  }, [screenShareTrack]);

  useEffect(() => {
    const element = containerRef.current;
    if (!element) {
      return;
    }

    const updateSize = () => {
      const rect = element.getBoundingClientRect();
      setContainerSize({ width: rect.width, height: rect.height });
    };

    updateSize();

    const observer = new ResizeObserver(updateSize);
    observer.observe(element);

    return () => observer.disconnect();
  }, []);

  const handleVideoLoaded = useCallback(() => {
    setIsLoading(false);
    if (videoRef.current) {
      observeFirstRenderedFrame(videoRef.current, screenShareTrack);
      setVideoSize({
        width: videoRef.current.videoWidth,
        height: videoRef.current.videoHeight,
      });
    }
  }, [screenShareTrack]);

  // Reset pan when zoom resets
  useEffect(() => {
    if (zoom === 1) {
      setPan({ x: 0, y: 0 });
    }
  }, [zoom]);

  const handleZoomIn = useCallback(() => {
    setZoom((z) => Math.min(z + ZOOM_STEP, MAX_ZOOM));
  }, []);

  const handleZoomOut = useCallback(() => {
    setZoom((z) => Math.max(z - ZOOM_STEP, MIN_ZOOM));
  }, []);

  const handleResetZoom = useCallback(() => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
    setRotation(0);
  }, []);

  const toggleRotation = useCallback(() => {
    setRotation((prev) => (prev - 90) % 360);
    setZoom(1);
    setPan({ x: 0, y: 0 });
  }, []);

  const stageSize = useMemo(() => getContainedSize(containerSize.width, containerSize.height, videoSize.width, videoSize.height), [containerSize.height, containerSize.width, videoSize.height, videoSize.width]);

  const stageStyle = useMemo(
    () => ({
      width: stageSize.width || containerSize.width,
      height: stageSize.height || containerSize.height,
      transform: `translate(calc(-50% + ${pan.x}px), calc(-50% + ${pan.y}px)) rotate(${rotation}deg) scale(${zoom})`,
      transformOrigin: "center center",
    }),
    [containerSize.height, containerSize.width, pan.x, pan.y, rotation, stageSize.height, stageSize.width, zoom],
  );

  // Mouse wheel zoom
  const handleWheel = useCallback(
    (e: React.WheelEvent) => {
      if (!enableZoom) return;
      e.preventDefault();
      const delta = e.deltaY > 0 ? -ZOOM_STEP : ZOOM_STEP;
      setZoom((z) => Math.max(MIN_ZOOM, Math.min(z + delta, MAX_ZOOM)));
    },
    [enableZoom],
  );

  // Pan handlers
  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (e.target !== e.currentTarget && e.target !== videoRef.current) {
        return;
      }

      if (zoom <= 1) return;
      setIsDragging(true);
      dragStart.current = {
        x: e.clientX,
        y: e.clientY,
        panX: pan.x,
        panY: pan.y,
      };
    },
    [zoom, pan],
  );

  const handleMouseMove = useCallback(
    (e: React.MouseEvent) => {
      if (!isDragging || zoom <= 1) return;

      const dx = e.clientX - dragStart.current.x;
      const dy = e.clientY - dragStart.current.y;

      const maxPanX = (stageSize.width * (zoom - 1)) / 2;
      const maxPanY = (stageSize.height * (zoom - 1)) / 2;
      setPan({
        x: Math.max(-maxPanX, Math.min(maxPanX, dragStart.current.panX + dx)),
        y: Math.max(-maxPanY, Math.min(maxPanY, dragStart.current.panY + dy)),
      });
    },
    [isDragging, stageSize.height, stageSize.width, zoom],
  );

  const handleMouseUp = useCallback(() => {
    setIsDragging(false);
  }, []);

  const handleMouseLeave = useCallback(() => {
    setIsDragging(false);
  }, []);

  const toggleThumbnails = useCallback(() => {
    setIsThumbnailsOpen((prev) => !prev);
  }, []);

  return (
    <div className={cn("flex h-full w-full gap-2 transition-all duration-500", thumbnailPosition === "bottom" ? "flex-col" : "flex-row", className)}>
      <ChalkPanel tone="neutral" filled className="relative min-h-0 min-w-0 flex-1 overflow-hidden rounded-2xl p-0 [&>div]:h-full [&>div]:w-full">
        <div ref={containerRef} className="group relative h-full min-h-0 min-w-0 overflow-hidden bg-[var(--chalk-text)]" onWheel={handleWheel} onMouseDown={handleMouseDown} onMouseMove={handleMouseMove} onMouseUp={handleMouseUp} onMouseLeave={handleMouseLeave}>
          {/* Loading State */}
          {isLoading && (
            <div className="absolute inset-0 z-10 flex flex-col items-center justify-center bg-[var(--chalk-canvas)] transition-opacity duration-500">
              <div className="relative">
                <div className="absolute -inset-4 rounded-full bg-[var(--chalk-accent)] blur-xl animate-pulse" />
                <ChalkSpinner className="relative z-10 size-12 text-[var(--chalk-accent)]" label="Connecting" />
              </div>
              <div className="mt-6 flex flex-col items-center gap-2 animate-in fade-in slide-in-from-bottom-4 duration-700 delay-300">
                <div className="flex items-center gap-2 text-[var(--chalk-accent-text)] font-medium">
                  <Monitor01Icon size={18} className="text-[var(--chalk-accent)]" />
                  <span>Connecting to {sharedByName}'s screen...</span>
                </div>
                <p className="text-xs text-[var(--chalk-accent-text)]">Setting up the high-quality stream</p>
              </div>
            </div>
          )}

          <div className="absolute left-1/2 top-1/2" style={stageStyle}>
            <video
              ref={videoRef}
              autoPlay
              playsInline
              muted
              onLoadedData={handleVideoLoaded}
              onLoadedMetadata={handleVideoLoaded}
              className={cn("h-full w-full rounded-xl bg-[var(--chalk-text)] transition-all duration-700", isLoading ? "opacity-0 scale-95" : "opacity-100 scale-100", zoom > 1 && isDragging && "cursor-grabbing", zoom > 1 && !isDragging && "cursor-grab")}
            />
          </div>

          <ChalkBadge tone="accent" className={cn("absolute top-3 left-3 text-xs font-medium transition-opacity duration-500", isLoading ? "opacity-0" : "opacity-100")}>
            Shared by {sharedByName}
          </ChalkBadge>

          {/* Zoom controls */}
          {enableZoom && (
            <ChalkControlGroup className="absolute top-3 right-3 opacity-0 transition-opacity group-hover:opacity-100">
              <ChalkIconButton size="sm" tone={rotation !== 0 ? "accent" : "neutral"} onClick={toggleRotation} className="rounded-full p-1.5" aria-label="Rotate view">
                <RefreshIcon size={14} style={{ transform: `rotate(${-rotation}deg)` }} className="transition-transform duration-500 ease-in-out" />
              </ChalkIconButton>
              <ChalkDivider className="mx-0 my-0 h-8 w-2" aria-hidden="true" />
              <ChalkIconButton size="sm" tone="neutral" onClick={handleZoomOut} disabled={zoom <= MIN_ZOOM} className="rounded-full p-1.5" aria-label="Zoom out">
                <ZoomOutIcon size={14} />
              </ChalkIconButton>
              <ChalkBadge tone="neutral" className="min-w-[2.5rem] justify-center text-xs font-medium">
                {Math.round(zoom * 100)}%
              </ChalkBadge>
              <ChalkIconButton size="sm" tone="neutral" onClick={handleZoomIn} disabled={zoom >= MAX_ZOOM} className="rounded-full p-1.5" aria-label="Zoom in">
                <ZoomInIcon size={14} />
              </ChalkIconButton>
              {(zoom > 1 || rotation !== 0) && (
                <ChalkIconButton size="sm" tone="accent" onClick={handleResetZoom} className="rounded-full p-1.5" aria-label="Reset zoom">
                  <Maximize01Icon size={14} />
                </ChalkIconButton>
              )}
            </ChalkControlGroup>
          )}

          {/* Zoom indicator when zoomed */}
          {zoom > 1 && (
            <ChalkBadge tone="neutral" className="absolute bottom-3 right-3 rounded text-[10px]">
              Drag to pan • Scroll to zoom
            </ChalkBadge>
          )}

          {onStopShare && (
            <div className="absolute bottom-4 left-1/2 -translate-x-1/2 opacity-0 group-hover:opacity-100 transition-opacity">
              <ChalkButton type="button" onClick={onStopShare} tone="danger" variant="solid" className="font-medium shadow-lg">
                Stop Sharing
              </ChalkButton>
            </div>
          )}

          {/* Collapse/Expand Toggle Button */}
          {showThumbnails && participants.length > 0 && (
            <ChalkIconButton
              size="sm"
              tone="neutral"
              onClick={toggleThumbnails}
              className={cn("absolute z-20 rounded-full p-0 shadow-lg transition-all duration-300", thumbnailPosition === "right" ? "top-1/2 right-1 h-12 w-8 -translate-y-1/2" : "bottom-1 left-1/2 h-8 w-12 -translate-x-1/2")}
              aria-label={isThumbnailsOpen ? "Collapse sidebar" : "Expand sidebar"}
            >
              {thumbnailPosition === "right" ? isThumbnailsOpen ? <ArrowRight01Icon size={16} /> : <ArrowLeft01Icon size={16} /> : isThumbnailsOpen ? <ArrowDown01Icon size={16} /> : <ArrowUp01Icon size={16} />}
            </ChalkIconButton>
          )}
        </div>
      </ChalkPanel>

      {showThumbnails && participants.length > 0 && (
        <ChalkPanel
          tone="neutral"
          filled
          className={cn("p-1 transition-all duration-500 ease-in-out [&>div]:h-full [&>div]:w-full", !isThumbnailsOpen && (thumbnailPosition === "bottom" ? "h-0 opacity-0" : "w-0 opacity-0 px-0"), isThumbnailsOpen && (thumbnailPosition === "bottom" ? "h-36 w-full" : "w-56 h-full"))}
        >
          <ChalkControlGroup orientation={thumbnailPosition === "bottom" ? "horizontal" : "vertical"} className={cn("h-full w-full gap-2", thumbnailPosition === "bottom" ? "items-center overflow-auto px-1" : "overflow-y-auto overflow-x-hidden py-1")} role="presentation">
            {participants.map((p) => (
              <div key={p.id} className={cn("shrink-0 rounded-xl overflow-hidden relative transition-all duration-500", thumbnailPosition === "bottom" ? "aspect-video h-full" : "aspect-video w-full", !isThumbnailsOpen && "scale-0 opacity-0")}>
                <ParticipantTile
                  participant={{
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
                  }}
                  videoTrack={p.videoTrack}
                  className="w-full h-full"
                  showName={true}
                  showStatus={true}
                />
              </div>
            ))}
          </ChalkControlGroup>
        </ChalkPanel>
      )}
    </div>
  );
});

export function ScreenShareView(props: ScreenShareViewProps): React.JSX.Element {
  const skin = useSkin();
  return skin === "classic" ? <ClassicScreenShareView {...props} /> : <ChalkScreenShareView {...props} />;
}

function ChalkScreenShareView(props: ScreenShareViewProps): React.JSX.Element {
  const client = useSpaceClient();
  const self = useSelf();
  const participantsSlice = useParticipants();
  const media = useMedia();
  const localId = self.participantId ?? "local";
  const participants = useMemo(() => toVideoParticipants(participantsSlice.roster, media.remote, localId, self.displayName ?? "You", media.local), [localId, media.local, media.remote, participantsSlice.roster, self.displayName]);
  const active = participants.find((participant) => participant.isScreenSharing && participant.screenShareTrack);

  if (!active?.screenShareTrack) {
    return <ChalkEmptyState className="grid h-full place-items-center text-sm text-[var(--chalk-app-text-muted)]" title="No active screen share" />;
  }

  return (
    <ScreenShareViewSurface
      {...props}
      screenShareTrack={active.screenShareTrack}
      sharedByName={active.displayName}
      participants={participants}
      onStopShare={props.onStopShare ?? (() => void (active.isLocal ? client.media.setScreenShareEnabled(false) : client.participants.stopScreenShare(active.id)))}
    />
  );
}

ChalkScreenShareView.displayName = "ChalkScreenShareView";

ScreenShareView.displayName = "ScreenShareView";
