import React, { useRef, type CSSProperties } from "react";

import { ScreenSharePresentation, type ScreenSharePresentationProps } from "../composite/ScreenShareView";
import { Edit02Icon } from "../../utils/icons";
import { TileShell } from "../participant-tile/TileShell";
import { useVideoTrack } from "../participant-tile/useVideoTrack";
import type { StageItem } from "./stage-items";

type ContentItem = Extract<StageItem, { kind: "screen-share" | "whiteboard" }>;

export interface StageContentTileProps extends Pick<ScreenSharePresentationProps, "onStopSharing" | "onChangeShare" | "capture" | "switcher"> {
  readonly primary?: boolean;
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

export interface StageContentTileSurfaceProps extends Omit<StageContentTileProps, "active"> {
  readonly media?: React.ReactNode;
  readonly mediaVisible: boolean;
  readonly state?: ScreenSharePresentationProps["state"];
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
export const StageContentTile = React.memo(function StageContentTile({ item, active, ...props }: StageContentTileProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const track = item.kind === "screen-share" ? item.participant.screenShareTrack : null;
  const status = useVideoTrack(videoRef, track, active);

  return (
    <StageContentTileSurface
      item={item}
      {...props}
      state={item.kind === "screen-share" ? item.participant.screenShareState ?? (status === "muted" ? "paused" : undefined) : undefined}
      media={item.kind === "screen-share" ? <video ref={videoRef} autoPlay playsInline muted className="h-full w-full object-contain" /> : undefined}
      mediaVisible={status === "playing" || status === "muted"}
    />
  );
});

export const StageContentTileSurface = React.memo(function StageContentTileSurface({ item, pinned, onClick, onDoubleClick, className, style, hidden, media, mediaVisible, primary, state, onStopSharing, onChangeShare, capture, switcher }: StageContentTileSurfaceProps) {
  if (item.kind === "screen-share") return <ScreenSharePresentation sharedByName={item.participant.displayName} media={media} mediaVisible={mediaVisible} state={state ?? item.participant.screenShareState} isLocal={item.participant.isLocal} hasAudio={item.participant.screenShareHasAudio} primary={primary} pinned={pinned} onClick={onClick} onDoubleClick={onDoubleClick} className={className} style={style} hidden={hidden} onStopSharing={onStopSharing} onChangeShare={onChangeShare} capture={capture} switcher={switcher} />;
  const accentColor = BOARD_ACCENT;
  const Icon = Edit02Icon;

  return (
    <TileShell
      label={contentTileLabel(item)}
      accentColor={accentColor}
      pinned={pinned}
      onClick={primary ? undefined : onClick}
      onDoubleClick={onDoubleClick}
      className={className}
      style={style}
      dataTour="video-grid"
      hidden={hidden}
      chip={primary ? null : (
        <>
          <Icon size={14} className="shrink-0" />
          <span className="min-w-0 truncate">{contentTileName(item)}</span>
        </>
      )}
    >
      <div className="relative z-10 block h-full w-full overflow-hidden bg-[var(--chalk-app-tile-base)] [&>*]:h-full [&>*]:w-full [&>*]:object-contain">{media}</div>
      {!mediaVisible && (
        <div className="chalk-participant-wash absolute inset-0 z-10 flex items-center justify-center text-[var(--chalk-app-text-muted)]">
          <Icon size={32} />
        </div>
      )}
    </TileShell>
  );
});

StageContentTile.displayName = "StageContentTile";
StageContentTileSurface.displayName = "StageContentTileSurface";
