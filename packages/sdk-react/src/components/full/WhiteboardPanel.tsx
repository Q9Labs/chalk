/**
 * WhiteboardPanel - Integrated collaborative whiteboard using Excalidraw
 *
 * Integrated component that acts as a "Stage" in the video conference.
 * Handles sync, permissions, and participant thumbnails.
 */

import { memo, useCallback, useState } from "react";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

import { useSession } from "../../context/chalk-provider";
import { useWhiteboard } from "../../hooks/features/useWhiteboard";
import { useWhiteboardPermissions } from "../../hooks/useWhiteboardPermissions";
import { cn } from "../../utils/cn";
import { ArrowDown01Icon, ArrowLeft01Icon, ArrowRight01Icon, ArrowUp01Icon } from "../../utils/icons";
import { VideoTile } from "../atomic";
import type { Participant } from "../composite/VideoGrid";
import { EXCALIDRAW_CSS_CDN } from "./whiteboard-panel/constants";
import { LockIcon, UnlockIcon } from "./whiteboard-panel/icons";
import type { WhiteboardSessionLike } from "./whiteboard-panel/types";
import { useWhiteboardExcalidrawMount } from "./whiteboard-panel/useWhiteboardExcalidrawMount";
import { useWhiteboardSync } from "./whiteboard-panel/useWhiteboardSync";

export interface WhiteboardPanelProps {
  /** Called when whiteboard should close */
  onClose?: () => void;
  /** Controls visibility without unmounting (preserves state) */
  isVisible?: boolean;
  /** Custom CSS class */
  className?: string;
  /**
   * URL or path to Excalidraw CSS.
   * Defaults to jsDelivr CDN which includes fonts automatically.
   * Set to a local path (e.g., "/vendor/excalidraw.css") if self-hosting.
   */
  excalidrawCssPath?: string;
  /** Theme override */
  theme?: "light" | "dark" | "auto";
  /** List of participants to display in thumbnails */
  participants?: Participant[];
  /** Whether to show participant thumbnails */
  showThumbnails?: boolean;
  /** Position of thumbnails relative to whiteboard */
  thumbnailPosition?: "bottom" | "right";
  /** Exposes Excalidraw imperative API (for overlays/extensions). Called once per mount. */
  onExcalidrawApiReady?: (api: ExcalidrawImperativeAPI) => void;
}

/**
 * Integrated collaborative whiteboard panel
 *
 * Uses Excalidraw with real-time sync via the SDK's whiteboard system.
 * Automatically handles permissions, cursors, and element syncing.
 */
function WhiteboardPanelBase({ isVisible = true, className, excalidrawCssPath = EXCALIDRAW_CSS_CDN, theme = "auto", participants = [], showThumbnails = true, thumbnailPosition = "bottom", onExcalidrawApiReady }: WhiteboardPanelProps): React.JSX.Element {
  const rawSession = useSession();
  const session = rawSession as unknown as WhiteboardSessionLike;
  const { canDraw, cursors, latestUpdate, latestSnapshot, sendUpdate, sendCursor, requestSync } = useWhiteboard();
  const { canGrant, grantAll, revokeAll } = useWhiteboardPermissions();
  const useV2 = rawSession.whiteboardSyncV2 ?? true;

  const [isThumbnailsOpen, setIsThumbnailsOpen] = useState(true);
  const toggleThumbnails = useCallback(() => {
    setIsThumbnailsOpen((prev) => !prev);
  }, []);

  const resolvedTheme = theme === "auto" ? (typeof document !== "undefined" && document.documentElement.classList.contains("dark") ? "dark" : "light") : theme;

  const { refs, containerRef, isReady, cssLoaded, loadError } = useWhiteboardExcalidrawMount({
    useV2,
    canDraw,
    resolvedTheme,
    excalidrawCssPath,
    session,
    sendUpdate,
    sendCursor,
    onExcalidrawApiReady,
  });

  useWhiteboardSync({
    useV2,
    canDraw,
    requestSync,
    latestUpdate,
    latestSnapshot,
    cursors,
    session,
    refs,
  });

  const isDarkTheme = resolvedTheme === "dark";
  const isDarkCanvas = isDarkTheme;
  const pillBg = isDarkCanvas ? "bg-black/50" : "bg-white/80";
  const pillBorder = isDarkCanvas ? "border-white/10" : "border-black/10";
  const buttonText = isDarkCanvas ? "text-white/70 hover:text-white" : "text-black/70 hover:text-black";
  const buttonHover = isDarkCanvas ? "hover:bg-white/10" : "hover:bg-black/10";

  return (
    <div className={cn("flex h-full w-full gap-2 transition-all duration-500", thumbnailPosition === "bottom" ? "flex-col" : "flex-row", !isVisible && "hidden", className)}>
      <div className="relative flex-1 min-h-0 min-w-0 rounded-2xl overflow-hidden bg-background">
        {canGrant && (
          <div className={cn("absolute top-4 right-4 z-10 rounded-lg p-1 backdrop-blur-md border flex items-center gap-1", pillBg, pillBorder)}>
            <button type="button" onClick={grantAll} className={cn("w-8 h-8 rounded-md flex items-center justify-center transition-colors", buttonText, buttonHover)} aria-label="Enable drawing for all" title="Enable All">
              <UnlockIcon />
            </button>
            <button type="button" onClick={revokeAll} className={cn("w-8 h-8 rounded-md flex items-center justify-center transition-colors", buttonText, buttonHover)} aria-label="Disable drawing for all" title="Disable All">
              <LockIcon />
            </button>
          </div>
        )}

        {(!isReady || !cssLoaded) && !loadError && (
          <div className="absolute inset-0 flex items-center justify-center text-foreground bg-background z-20">
            <div className="flex flex-col items-center gap-3">
              <div className="w-8 h-8 border-2 border-primary border-t-transparent rounded-full animate-spin" />
              <span>Loading whiteboard...</span>
            </div>
          </div>
        )}

        {loadError && (
          <div className="absolute inset-0 flex items-center justify-center text-destructive bg-background z-20">
            <div className="flex flex-col items-center gap-3 max-w-md text-center px-4">
              <span className="text-lg font-medium">Failed to load whiteboard</span>
              <span className="text-sm text-muted-foreground">{loadError}</span>
            </div>
          </div>
        )}

        <div ref={containerRef} className="h-full w-full" />

        {showThumbnails && participants.length > 0 && (
          <button
            type="button"
            onClick={toggleThumbnails}
            className={cn(
              "absolute z-20 flex items-center justify-center bg-zinc-950/50 backdrop-blur-md border border-white/10 text-white/80 hover:text-white hover:bg-zinc-950/80 transition-all duration-300 shadow-lg",
              thumbnailPosition === "right" ? "top-1/2 -translate-y-1/2 right-1 w-6 h-12 rounded-l-xl" : "left-1/2 -translate-x-1/2 bottom-1 w-12 h-6 rounded-t-xl",
            )}
            aria-label={isThumbnailsOpen ? "Collapse sidebar" : "Expand sidebar"}
          >
            {thumbnailPosition === "right" ? isThumbnailsOpen ? <ArrowRight01Icon size={16} /> : <ArrowLeft01Icon size={16} /> : isThumbnailsOpen ? <ArrowDown01Icon size={16} /> : <ArrowUp01Icon size={16} />}
          </button>
        )}
      </div>

      {showThumbnails && participants.length > 0 && (
        <div
          className={cn(
            "flex gap-2 transition-all duration-500 ease-in-out",
            thumbnailPosition === "bottom" ? "flex-row items-center px-2 overflow-auto" : "flex-col py-2 overflow-y-auto overflow-x-hidden",
            !isThumbnailsOpen && (thumbnailPosition === "bottom" ? "h-0 opacity-0" : "w-0 opacity-0 px-0"),
            isThumbnailsOpen && (thumbnailPosition === "bottom" ? "h-36 w-full" : "w-56 h-full"),
          )}
        >
          {participants.map((p) => (
            <div key={p.id} className={cn("shrink-0 rounded-xl overflow-hidden relative transition-all duration-500", thumbnailPosition === "bottom" ? "aspect-video h-full" : "aspect-video w-full", !isThumbnailsOpen && "scale-0 opacity-0")}>
              <VideoTile
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
        </div>
      )}
    </div>
  );
}

export const WhiteboardPanel = memo(WhiteboardPanelBase);
WhiteboardPanel.displayName = "WhiteboardPanel";

export default WhiteboardPanel;
