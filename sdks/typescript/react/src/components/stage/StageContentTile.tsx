import React, { useRef, type CSSProperties } from "react";

import { cn } from "../../utils/cn";
import { getParticipantColor } from "../../utils/colorGenerator";
import { Edit02Icon, Monitor01Icon } from "../../utils/icons";
import { TileShell } from "../participant-tile/TileShell";
import { useVideoTrack } from "../participant-tile/useVideoTrack";
import type { StageItem } from "./stage-items";

type ContentItem = Extract<StageItem, { kind: "screen-share" | "whiteboard" }>;

export interface StageContentTileProps {
  readonly item: ContentItem;
  /** Whether the tile is on the visible page; off-page tiles keep their video detached. */
  readonly active: boolean;
  readonly pinned?: boolean;
  readonly onClick?: () => void;
  readonly onDoubleClick?: () => void;
  readonly className?: string;
  readonly style?: CSSProperties;
  readonly hidden?: boolean;
}

const BOARD_ACCENT = "var(--chalk-app-line-strong, currentColor)";

export function contentTileLabel(item: ContentItem): string {
  return item.kind === "whiteboard" ? "Whiteboard tile" : `Screen share tile for ${item.participant.displayName}`;
}

export function contentTileName(item: ContentItem): string {
  if (item.kind === "whiteboard") return "Board";
  return item.participant.isLocal ? "Your screen" : `${item.participant.displayName}'s screen`;
}

/** Unfocused screen share or whiteboard rendered with the same chrome as a participant tile. */
export const StageContentTile = React.memo(function StageContentTile({ item, active, pinned, onClick, onDoubleClick, className, style, hidden }: StageContentTileProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const track = item.kind === "screen-share" ? item.track : null;
  const status = useVideoTrack(videoRef, track, active);
  const showVideo = status === "playing";
  const accentColor = item.kind === "screen-share" ? getParticipantColor(item.participant.displayName || item.participant.id).primary : BOARD_ACCENT;
  const Icon = item.kind === "whiteboard" ? Edit02Icon : Monitor01Icon;

  return (
    <TileShell
      label={contentTileLabel(item)}
      accentColor={accentColor}
      pinned={pinned}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      className={className}
      style={style}
      dataTour="video-grid"
      hidden={hidden}
      chip={
        <>
          <Icon size={12} className="shrink-0 !text-[var(--chalk-accent-text)]" />
          <span className="max-w-[140px] truncate text-xs font-medium !text-[var(--chalk-accent-text)]">{contentTileName(item)}</span>
        </>
      }
    >
      {item.kind === "screen-share" ? <video ref={videoRef} autoPlay playsInline muted className={cn("relative z-10 block h-full w-full bg-[var(--chalk-app-tile-base)] object-contain transition-opacity duration-300", showVideo ? "opacity-100" : "opacity-0")} /> : null}
      {!showVideo && (
        <div className="chalk-participant-wash chalk-textured-surface absolute inset-0 z-10 flex items-center justify-center text-[var(--chalk-app-text-muted)]">
          <Icon size={32} />
        </div>
      )}
    </TileShell>
  );
});

StageContentTile.displayName = "StageContentTile";
