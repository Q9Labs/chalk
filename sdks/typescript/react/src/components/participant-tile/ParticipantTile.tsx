import { Facehash } from "@q9labsai/facehash/react";
import React, { useMemo, useRef, useState } from "react";

import { usePrefersReducedMotion, useMediaQuery } from "../../internal/useMediaQuery";
import { useMirrorSetting } from "../../internal/useMirrorSetting";
import { cn } from "../../utils/cn";
import { getParticipantColor, getParticipantAvatarRecipe, type ParticipantGradientPreference } from "../../utils/colorGenerator";
import { StageIcon } from "../stage/StageIcon";
import { Avatar } from "../atomic/Avatar";
import { ChalkMenu, ChalkMenuItem, ChalkSheet } from "../chalk-ui";
import { TileShell } from "./TileShell";
import { useVideoTrack } from "./useVideoTrack";

export interface ParticipantTileProps {
  participant: {
    id: string;
    displayName: string;
    isLocal?: boolean;
    isSpeaking?: boolean;
    /** Normalized voice level (0–1). Activity-only integrations use a neutral speaking level. */
    audioLevel?: number;
    isMuted?: boolean;
    isVideoEnabled?: boolean;
    isScreenSharing?: boolean;
    isHandRaised?: boolean;
    handRaiseOrder?: number;
    /** 0 means unknown; 1–2 show a poor-connection badge. */
    connectionQuality?: 0 | 1 | 2 | 3 | 4;
    avatarUrl?: string;
  };
  videoTrack?: MediaStreamTrack | null;
  /** Mirror the video horizontally. Defaults to the persisted self-view preference for local cameras, false for remote cameras. */
  mirror?: boolean;
  showName?: boolean;
  showStatus?: boolean;
  aspectRatio?: "16:9" | "4:3" | "1:1" | "fill";
  onClick?: () => void;
  onDoubleClick?: () => void;
  pinned?: boolean;
  /** While the board is open, a click follows this person's view instead of pinning the tile. */
  clickAction?: "pin" | "follow";
  following?: boolean;
  primary?: boolean;
  className?: string;
  style?: React.CSSProperties;
  children?: React.ReactNode;
  showAvatar?: boolean;
  /** Show a generated Facehash when the Participant has no uploaded avatar. */
  generatedAvatars?: boolean;
  gradientPreference?: ParticipantGradientPreference;
  /** Keeps the tile mounted but out of the accessibility tree and tab order (off-page on the stage). */
  hidden?: boolean;
}

export interface ParticipantTileSurfaceProps extends Omit<ParticipantTileProps, "videoTrack"> {
  readonly media?: React.ReactNode;
  readonly mediaVisible: boolean;
  readonly animatedAvatars?: boolean;
}

const aspectRatioClasses = {
  "16:9": "aspect-video",
  "4:3": "aspect-[4/3]",
  "1:1": "aspect-square",
  fill: "",
};

export const ParticipantTile = React.memo(function ParticipantTile({ videoTrack, ...props }: ParticipantTileProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const status = useVideoTrack(videoRef, videoTrack, props.participant.isVideoEnabled === true);

  return <ParticipantTileSurface {...props} media={<video ref={videoRef} autoPlay playsInline muted className="h-full w-full object-cover" />} mediaVisible={status === "playing"} />;
});

export const ParticipantTileSurface = React.memo(function ParticipantTileSurface({
  participant,
  mirror,
  showName = true,
  showStatus = true,
  showAvatar = true,
  generatedAvatars = true,
  aspectRatio = "16:9",
  onClick,
  onDoubleClick,
  pinned,
  clickAction = "pin",
  following = false,
  primary,
  className,
  style,
  children,
  gradientPreference,
  hidden,
  media,
  mediaVisible,
  animatedAvatars = true,
}: ParticipantTileSurfaceProps) {
  const prefersReducedMotion = usePrefersReducedMotion();
  const phone = useMediaQuery("(max-width:640px)");
  const [optionsOpen, setOptionsOpen] = useState(false);
  const returnFocus = useRef<HTMLElement | null>(null);
  const openOptions = () => {
    returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setOptionsOpen(true);
  };
  const closeOptions = () => {
    setOptionsOpen(false);
    queueMicrotask(() => returnFocus.current?.focus());
  };
  const [localMirrored] = useMirrorSetting();
  const mirrored = mirror ?? (participant.isLocal === true && localMirrored);
  const colors = useMemo(() => getParticipantColor(participant.displayName || participant.id, gradientPreference), [gradientPreference, participant.displayName, participant.id]);
  const recipe = useMemo(() => getParticipantAvatarRecipe(participant.displayName || participant.id, gradientPreference), [participant.displayName, participant.id, gradientPreference]);
  const first = participant.displayName.split(" ")[0] ?? participant.displayName;
  const actionLabel = clickAction === "follow" ? `${following ? "Stop following" : "Follow"} ${first}` : `${pinned ? "Unpin" : "Pin"} ${participant.displayName}`;
  const hasPoorConnection = participant.connectionQuality !== undefined && participant.connectionQuality > 0 && participant.connectionQuality <= 2;

  return (
    <TileShell
      label={clickAction === "follow" ? actionLabel : `Video tile for ${participant.displayName}`}
      accentColor={colors.primary}
      pinned={clickAction === "follow" ? following : pinned}
      ring={following}
      lift={!primary}
      speaking={mediaVisible && participant.isSpeaking && !participant.isMuted}
      audioLevel={participant.audioLevel}
      onClick={onClick && phone && clickAction === "pin" ? openOptions : onClick}
      onDoubleClick={onDoubleClick}
      className={cn(aspectRatioClasses[aspectRatio], className)}
      style={style}
      dataTour={participant.isLocal ? "local-video" : "video-grid"}
      hidden={hidden}
      corner={
        <>
          {showStatus && hasPoorConnection ? (
            <span role="img" data-part="tile-signal" aria-label={`${participant.displayName} has a weak connection`} className="pointer-events-none absolute top-2 left-2 z-30 flex h-6 items-center rounded-[6px] bg-[var(--chalk-overlay)] px-[7px]">
              <SignalBars />
            </span>
          ) : null}
          {onClick && !phone ? (
            <span data-part="tile-menu" className="absolute top-2 right-2 z-30 opacity-0 transition-opacity duration-150 group-hover/tile:opacity-100 focus-within:opacity-100">
              <ChalkMenu
                trigger={
                  <button
                    type="button"
                    aria-label={`More options for ${participant.displayName}`}
                    className="grid h-8 w-8 place-items-center rounded-full bg-[var(--chalk-overlay)] text-white outline-none hover:bg-[var(--chalk-overlay-hover)] focus-visible:ring-2 focus-visible:ring-[var(--chalk-focus)]"
                  >
                    <StageIcon name="more" size={18} />
                  </button>
                }
              >
                <ChalkMenuItem onClick={onClick}>{actionLabel}</ChalkMenuItem>
              </ChalkMenu>
            </span>
          ) : null}
        </>
      }
      chip={
        showName || showStatus ? (
          <>
            {pinned && <StageIcon name="pin" size={14} aria-label="Pinned" />}
            {showName && (
              <>
                <span dir="auto" data-part="tile-full-name" className="min-w-0 truncate [unicode-bidi:plaintext]" title={participant.displayName}>
                  {participant.displayName}
                  {participant.isLocal && participant.displayName !== "You" && <span className="text-white"> (You)</span>}
                </span>
                <span dir="auto" data-part="tile-short-name" className="hidden min-w-0 truncate [unicode-bidi:plaintext]">
                  {participant.isLocal ? "You" : participant.displayName.split(" ")[0]}
                </span>
              </>
            )}
            {following ? (
              <span data-part="tile-following" className="shrink-0 font-semibold opacity-80">
                following
              </span>
            ) : null}
            {showStatus && participant.isMuted && <StageIcon name="mute" size={14} className="shrink-0 text-[#ff6b6b]" aria-label="Muted" />}
            {showStatus && participant.isHandRaised && (
              <span className="flex shrink-0 items-center text-[#e2bd3a]" role="img" aria-label={`Hand raised${participant.handRaiseOrder ? `, number ${participant.handRaiseOrder}` : ""}`}>
                <StageIcon name="hand" size={14} />
                {participant.handRaiseOrder ? <b className="ml-px text-[11px] font-bold">{participant.handRaiseOrder}</b> : null}
              </span>
            )}
          </>
        ) : null
      }
    >
      <div className={cn("absolute inset-0 overflow-hidden motion-safe:transition-opacity motion-safe:duration-200 [&>*]:h-full [&>*]:w-full [&>*]:object-cover", mirrored && "scale-x-[-1]", mediaVisible ? "opacity-100" : "opacity-0")}>{media}</div>
      {!mediaVisible && showAvatar && (
        <div aria-hidden="true" className="pointer-events-none absolute inset-0 grid place-items-center">
          <div aria-hidden="true" className="overflow-hidden rounded-full" style={{ width: "clamp(32px,42cqmin,150px)", height: "clamp(32px,42cqmin,150px)" }}>
            {generatedAvatars && !participant.avatarUrl ? (
              <Facehash
                role="img"
                aria-label={`Avatar for ${participant.displayName}`}
                className={cn(
                  !phone &&
                    !prefersReducedMotion &&
                    animatedAvatars &&
                    "group-hover/tile:[&_svg>g]:!transform-none [&_svg>g]:transition-[translate] [&_svg>g]:duration-[90ms] [&_svg>g]:ease-linear [&_text]:origin-bottom [&_text]:[transform-box:fill-box] [&_text]:transition-[scale] [&_text]:duration-[90ms] [&_text]:ease-linear",
                  !phone && !prefersReducedMotion && participant.isSpeaking && !participant.isMuted && "[&_svg>g]:translate-y-[calc(var(--chalk-voice-level)*-5px)] [&_text]:scale-y-[calc(1_+_var(--chalk-voice-level)*.55)]",
                )}
                name={participant.displayName || participant.id}
                size="100%"
                variant="solid"
                intensity3d="dramatic"
                interactive={!phone && !prefersReducedMotion && animatedAvatars}
                enableBlink={!phone && !prefersReducedMotion && animatedAvatars}
                colors={recipe.facehashColors}
              />
            ) : (
              <Avatar name={participant.displayName} src={participant.avatarUrl} size="xl" generated={false} style={{ width: "100%", height: "100%" }} />
            )}
          </div>
        </div>
      )}
      {phone && onClick && clickAction === "pin" ? (
        <ChalkSheet
          open={optionsOpen}
          onOpenChange={(open) => {
            if (open) openOptions();
            else closeOptions();
          }}
          title={`Options for ${participant.displayName}`}
        >
          <div className="flex items-center gap-3 px-2 pt-1 pb-3.5 text-base font-semibold">
            <Avatar name={participant.displayName} size="sm" />
            {participant.displayName}
          </div>
          <button
            type="button"
            className="flex min-h-[52px] w-full items-center gap-3.5 rounded-[16px] bg-[var(--chalk-raised)] px-4 text-left text-base leading-[1.4] hover:bg-[var(--chalk-hover)] active:bg-[var(--chalk-pressed)]"
            onClick={() => {
              onClick();
              closeOptions();
            }}
          >
            <StageIcon name="pin" size={20} className="text-[var(--chalk-soft-text)]" />
            <span>{pinned ? "Unpin" : "Pin"}</span>
          </button>
        </ChalkSheet>
      ) : null}
      {children}
    </TileShell>
  );
});

ParticipantTile.displayName = "ParticipantTile";
ParticipantTileSurface.displayName = "ParticipantTileSurface";

/** The weak-connection cue shares the mockup's three compact signal bars. */
export function SignalBars(): React.JSX.Element {
  return (
    <span aria-hidden="true" className="inline-flex h-3 items-end gap-0.5">
      {[6, 9, 12, 15].map((height, index) => (
        <i key={height} className="block w-[3px] rounded-[1px]" style={{ height, background: index === 0 ? "#e2bd3a" : "rgba(255,255,255,.3)" }} />
      ))}
    </span>
  );
}
