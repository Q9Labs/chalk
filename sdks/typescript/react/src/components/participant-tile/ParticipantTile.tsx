import React, { useMemo, useRef } from "react";

import { usePrefersReducedMotion } from "../../internal/useMediaQuery";
import { cn } from "../../utils/cn";
import { getParticipantColor, type ParticipantGradientPreference } from "../../utils/colorGenerator";
import { HandIcon, MicrophoneOff01Icon, Monitor01Icon, WifiOffIcon } from "../../utils/icons";
import { Avatar } from "../atomic/Avatar";
import { ChalkBadge } from "../chalk-ui";
import { TileShell } from "./TileShell";
import { useVideoTrack } from "./useVideoTrack";

export interface ParticipantTileProps {
  participant: {
    id: string;
    displayName: string;
    isLocal?: boolean;
    isSpeaking?: boolean;
    isMuted?: boolean;
    isVideoEnabled?: boolean;
    isScreenSharing?: boolean;
    isHandRaised?: boolean;
    /** 0 means unknown; 1–2 show a poor-connection badge. */
    connectionQuality?: 0 | 1 | 2 | 3 | 4;
    avatarUrl?: string;
  };
  videoTrack?: MediaStreamTrack | null;
  /** Mirror the video horizontally. Defaults to true for the local participant's own camera. */
  mirror?: boolean;
  showName?: boolean;
  showStatus?: boolean;
  aspectRatio?: "16:9" | "4:3" | "1:1" | "fill";
  onClick?: () => void;
  onDoubleClick?: () => void;
  pinned?: boolean;
  className?: string;
  style?: React.CSSProperties;
  children?: React.ReactNode;
  showAvatar?: boolean;
  gradientPreference?: ParticipantGradientPreference;
  /** Keeps the tile mounted but out of the accessibility tree and tab order (off-page on the stage). */
  hidden?: boolean;
}

const aspectRatioClasses = {
  "16:9": "aspect-video",
  "4:3": "aspect-[4/3]",
  "1:1": "aspect-square",
  fill: "",
};

export const ParticipantTile = React.memo(function ParticipantTile({ participant, videoTrack, mirror, showName = true, showStatus = true, showAvatar = true, aspectRatio = "16:9", onClick, onDoubleClick, pinned, className, style, children, gradientPreference, hidden }: ParticipantTileProps) {
  const prefersReducedMotion = usePrefersReducedMotion();
  const videoRef = useRef<HTMLVideoElement>(null);
  const status = useVideoTrack(videoRef, videoTrack, participant.isVideoEnabled === true);
  const showVideo = status === "playing";
  const mirrored = mirror ?? participant.isLocal === true;
  const colors = useMemo(() => getParticipantColor(participant.displayName || participant.id, gradientPreference), [gradientPreference, participant.displayName, participant.id]);
  const hasPoorConnection = participant.connectionQuality !== undefined && participant.connectionQuality > 0 && participant.connectionQuality <= 2;

  return (
    <TileShell
      label={`Video tile for ${participant.displayName}`}
      accentColor={colors.primary}
      pinned={pinned}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      className={cn(aspectRatioClasses[aspectRatio], className)}
      style={style}
      dataTour={participant.isLocal ? "local-video" : "video-grid"}
      hidden={hidden}
      corner={
        showStatus && hasPoorConnection ? (
          <ChalkBadge tone="danger" className="pointer-events-none absolute top-2 right-2 z-20 min-h-0 min-w-0 p-1" role="status" aria-label={`${participant.displayName} has a poor connection`}>
            <WifiOffIcon size={12} className="text-[var(--chalk-danger)]" />
          </ChalkBadge>
        ) : null
      }
      chip={
        showName || showStatus ? (
          <>
            {!showVideo && showAvatar && <Avatar name={participant.displayName} src={participant.avatarUrl} size="xs" generated={Boolean(participant.avatarUrl)} gradientPreference={gradientPreference} className="hidden shrink-0 @[240px]:flex" />}
            {showName && (
              <span className="min-w-0 truncate text-[11px] leading-4 font-medium tracking-[-0.01em] text-white @[240px]:text-[13px] @[240px]:leading-5" title={participant.displayName}>
                {participant.displayName}
                {participant.isLocal && participant.displayName !== "You" && <span className="text-white/65"> (You)</span>}
              </span>
            )}
            {showStatus && (participant.isMuted || participant.isSpeaking || participant.isHandRaised || participant.isScreenSharing) && (
              <span className="flex shrink-0 items-center gap-1 @[240px]:gap-1.5">
                {participant.isMuted && <MicrophoneOff01Icon size={14} className="h-3 w-3 text-[var(--chalk-app-danger,var(--chalk-danger))] @[240px]:h-3.5 @[240px]:w-3.5" aria-label="Muted" />}
                {!participant.isMuted && participant.isSpeaking && (
                  <span className="chalk-sound-bars" role="img" aria-label="Speaking">
                    <i />
                    <i />
                    <i />
                  </span>
                )}
                {participant.isHandRaised && (
                  <span className={cn("flex h-4 w-4 items-center justify-center rounded-full bg-[var(--chalk-yellow,#e2c25f)] text-[#1b1d22] @[240px]:h-[18px] @[240px]:w-[18px]", !prefersReducedMotion && "chalk-animate-hand-bounce")} aria-label="Hand raised">
                    <HandIcon size={11} className="h-2.5 w-2.5 @[240px]:h-[11px] @[240px]:w-[11px]" />
                  </span>
                )}
                {participant.isScreenSharing && <Monitor01Icon size={14} className="h-3 w-3 text-white/85 @[240px]:h-3.5 @[240px]:w-3.5" aria-label="Sharing screen" />}
              </span>
            )}
          </>
        ) : null
      }
    >
      <video ref={videoRef} autoPlay playsInline muted className={cn("relative z-10 block h-full w-full object-cover transition-opacity duration-300", mirrored && "scale-x-[-1]", showVideo ? "opacity-100" : "opacity-0")} />
      {!showVideo && showAvatar && (
        <div className="chalk-participant-wash chalk-textured-surface absolute inset-0 z-10 flex items-center justify-center">
          <span className={cn("relative grid place-items-center rounded-full", participant.isSpeaking && !participant.isMuted && "chalk-voice-halo")}>
            <Avatar name={participant.displayName} src={participant.avatarUrl} size="xl" generated={Boolean(participant.avatarUrl)} className="opacity-90" gradientPreference={gradientPreference} />
          </span>
        </div>
      )}
      {children}
    </TileShell>
  );
});

ParticipantTile.displayName = "ParticipantTile";
