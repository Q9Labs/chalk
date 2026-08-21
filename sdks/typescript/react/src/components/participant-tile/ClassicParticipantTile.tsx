import React, { useEffect, useRef, useState, useCallback, useMemo } from "react";
import { cn } from "../../utils/cn";
import { MicrophoneOff01Icon, Monitor01Icon, HandIcon, WifiOffIcon } from "../../utils/icons";
import { Avatar } from "../atomic/Avatar";
import { usePrefersReducedMotion } from "../../internal/useMediaQuery";
import { getParticipantColor } from "../../utils/colorGenerator";
import { observeFirstRenderedFrame } from "../../internal/episode-diagnostic-render-observer";
import type { ParticipantTileProps } from "./ParticipantTile";

function isTrackUsable(track: MediaStreamTrack | null | undefined): boolean {
  return !!track && track.readyState === "live" && track.enabled;
}

const aspectRatioClasses = {
  "16:9": "aspect-video",
  "4:3": "aspect-[4/3]",
  "1:1": "aspect-square",
  fill: "",
};

export const ClassicParticipantTile = React.memo(({ participant, videoTrack, mirror, showName = true, showStatus = true, showAvatar = true, aspectRatio = "16:9", onClick, onDoubleClick, pinned, className, style, children, gradientPreference, hidden }: ParticipantTileProps) => {
  const prefersReducedMotion = usePrefersReducedMotion();
  const videoRef = useRef<HTMLVideoElement>(null);
  const [trackError, setTrackError] = useState<string | null>(null);
  const [isLoaded, setIsLoaded] = useState(false);
  const [, setCurrentTrackId] = useState<string | null>(null);
  const [, forceUpdate] = useState(0);

  const attachTrack = useCallback((videoEl: HTMLVideoElement, track: MediaStreamTrack) => {
    const stream = new MediaStream([track]);
    videoEl.srcObject = stream;

    const attemptPlay = () => {
      videoEl.play().catch((err) => {
        if (err.name === "AbortError") return;
        const errorMsg = err instanceof Error ? err.message : "Play failed";
        if (!errorMsg.includes("interrupted")) {
          setTrackError(errorMsg);
        }
      });
    };

    attemptPlay();
  }, []);

  useEffect(() => {
    const videoEl = videoRef.current;
    if (!videoEl) return;

    setTrackError(null);
    setIsLoaded(false);

    const shouldShowVideo = participant.isVideoEnabled && videoTrack;

    if (!shouldShowVideo) {
      videoEl.srcObject = null;
      setCurrentTrackId(null);
      return;
    }

    if (!isTrackUsable(videoTrack)) {
      videoEl.srcObject = null;
      setCurrentTrackId(null);
      return;
    }

    const trackId = videoTrack.id;
    setCurrentTrackId(trackId);

    attachTrack(videoEl, videoTrack);

    const handleEnded = () => {
      setTrackError("Track ended");
      setIsLoaded(false);
      forceUpdate((n) => n + 1);
    };

    const handleMute = () => {
      forceUpdate((n) => n + 1);
    };

    const handleUnmute = () => {
      if (isTrackUsable(videoTrack)) {
        attachTrack(videoEl, videoTrack);
        setTrackError(null);
      }
    };

    videoTrack.addEventListener("ended", handleEnded);
    videoTrack.addEventListener("mute", handleMute);
    videoTrack.addEventListener("unmute", handleUnmute);

    return () => {
      videoTrack.removeEventListener("ended", handleEnded);
      videoTrack.removeEventListener("mute", handleMute);
      videoTrack.removeEventListener("unmute", handleUnmute);
    };
  }, [videoTrack, participant.isVideoEnabled, attachTrack]);

  const handleVideoLoaded = useCallback(() => {
    setIsLoaded(true);
    if (videoRef.current && videoTrack) observeFirstRenderedFrame(videoRef.current, videoTrack);
  }, [videoTrack]);

  const isTrackValid = isTrackUsable(videoTrack);
  const showVideo = participant.isVideoEnabled && videoTrack && isTrackValid && !trackError && isLoaded;

  const participantColors = useMemo(() => getParticipantColor(participant.displayName || participant.id, gradientPreference), [gradientPreference, participant.displayName, participant.id]);

  const hasPoorConnection = participant.connectionQuality !== undefined && participant.connectionQuality <= 2;

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      if (!onClick) return;
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        onClick();
      }
    },
    [onClick],
  );

  return (
    <div
      className={cn(
        "relative overflow-hidden rounded-[8px] border border-transparent outline-none transition-all duration-300",
        aspectRatioClasses[aspectRatio],
        pinned && "ring-2",
        participant.isSpeaking && !prefersReducedMotion && "chalk-animate-harmonic-pulse",
        participant.isSpeaking && prefersReducedMotion && "border-solid",
        hidden && "pointer-events-none",
        onClick && "cursor-pointer focus-visible:ring-2 focus-visible:ring-[var(--chalk-focus)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--chalk-canvas)]",
        className,
      )}
      style={
        {
          ...style,
          "--chalk-accent-speaking": participantColors.primary,
          "--chalk-accent-speaking-glow": `${participantColors.primary}4D`, // 30% opacity hex
          "--chalk-participant-color": participantColors.primary,
          borderColor: participant.isSpeaking && prefersReducedMotion ? participantColors.primary : undefined,
          ...(pinned ? { "--tw-ring-color": `${participantColors.primary}80` } : {}),
        } as React.CSSProperties
      }
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      onKeyDown={handleKeyDown}
      data-tour={participant.isLocal ? "local-video" : "video-grid"}
      role={onClick ? "button" : "region"}
      tabIndex={onClick && !hidden ? 0 : undefined}
      aria-hidden={hidden || undefined}
      aria-label={`Video tile for ${participant.displayName}`}
    >
      {/* Video element (always rendered, visibility controlled by CSS) */}
      <video ref={videoRef} autoPlay playsInline muted onLoadedData={handleVideoLoaded} className={cn("h-full w-full object-cover transition-opacity duration-500", mirror && "scale-x-[-1]", !showVideo ? "opacity-0" : "opacity-100")} />

      {/* Avatar background when video is off or loading */}
      {!showVideo && showAvatar && (
        <div className="chalk-participant-wash chalk-textured-surface absolute inset-0 flex items-center justify-center transition-opacity duration-300">
          <Avatar name={participant.displayName} src={participant.avatarUrl} size="xl" generated={Boolean(participant.avatarUrl)} className="opacity-90" gradientPreference={gradientPreference} />
        </div>
      )}

      {children}

      {/* Poor connection warning, top-right */}
      {showStatus && hasPoorConnection && (
        <div className="absolute top-2 right-2 flex items-center gap-1 px-1.5 py-1 rounded-full bg-[var(--chalk-text)] border border-[var(--chalk-line)] pointer-events-none" role="status" aria-label={`${participant.displayName} has a poor connection`}>
          <WifiOffIcon size={12} className="text-[var(--chalk-danger)]" />
        </div>
      )}

      {/* Compact bottom-left info chip */}
      {(showName || showStatus) && (
        <div className="pointer-events-none absolute right-2 bottom-2 left-2">
          <div className="inline-flex items-center gap-1.5 rounded-[5px] border border-[var(--chalk-line)] bg-[var(--chalk-text)] px-2 py-1">
            {/* Small avatar when video is off */}
            {!showVideo && showAvatar && <Avatar name={participant.displayName} src={participant.avatarUrl} size="xs" generated={Boolean(participant.avatarUrl)} gradientPreference={gradientPreference} />}

            {/* Name */}
            {showName && (
              <span className="max-w-[120px] truncate text-xs font-medium !text-[var(--chalk-accent-text)]" title={participant.displayName}>
                {participant.displayName}
                {participant.isLocal && participant.displayName !== "You" && <span className="!text-[var(--chalk-accent-text)]"> (You)</span>}
              </span>
            )}

            {/* Status icons inline */}
            {showStatus && (
              <div className="flex items-center gap-1 ml-auto">
                {participant.isMuted && (
                  <div className="rounded-full bg-[var(--chalk-danger)] p-0.5">
                    <MicrophoneOff01Icon size={10} className="text-[var(--chalk-accent-text)]" />
                  </div>
                )}
                {participant.isHandRaised && (
                  <div className={cn("rounded-full bg-[var(--chalk-danger-surface)] p-0.5", !prefersReducedMotion && "chalk-animate-hand-bounce")}>
                    <HandIcon size={10} className="text-[var(--chalk-accent-text)]" />
                  </div>
                )}
                {participant.isScreenSharing && (
                  <div className="rounded-full p-0.5" style={{ backgroundColor: `${participantColors.primary}CC` }}>
                    <Monitor01Icon size={10} className="text-[var(--chalk-accent-text)]" />
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
});

ClassicParticipantTile.displayName = "ClassicParticipantTile";
