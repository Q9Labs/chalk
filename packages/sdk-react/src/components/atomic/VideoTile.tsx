import React, { useEffect, useRef, useState, useCallback, useMemo } from "react";
import { cn } from "../../utils/cn";
import { MicrophoneOff01Icon, Monitor01Icon, HandIcon } from "../../utils/icons";
import { Avatar } from "./Avatar";
import { usePrefersReducedMotion } from "../../hooks/useMediaQuery";
import { getParticipantGradient, getParticipantColor } from "../../utils/colorGenerator";
import { useMeetingRoomSettings } from "../../hooks/useMeetingRoomSettings";
import { useMeetingRoomTheme } from "../full/meeting-room/useMeetingRoomTheme";

export interface VideoTileProps {
  participant: {
    id: string;
    displayName: string;
    isLocal?: boolean;
    isSpeaking?: boolean;
    isMuted?: boolean;
    isVideoEnabled?: boolean;
    isScreenSharing?: boolean;
    isHandRaised?: boolean;
    connectionQuality?: 1 | 2 | 3 | 4;
    avatarUrl?: string;
  };
  videoTrack?: MediaStreamTrack | null;
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
}

function isTrackUsable(track: MediaStreamTrack | null | undefined): boolean {
  return !!track && track.readyState === "live" && track.enabled;
}

const aspectRatioClasses = {
  "16:9": "aspect-video",
  "4:3": "aspect-[4/3]",
  "1:1": "aspect-square",
  fill: "",
};

export const VideoTile = React.memo(({ participant, videoTrack, mirror, showName = true, showStatus = true, showAvatar = true, aspectRatio = "16:9", onClick, onDoubleClick, pinned, className, style, children }: VideoTileProps) => {
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
  }, []);

  const isTrackValid = isTrackUsable(videoTrack);
  const showVideo = participant.isVideoEnabled && videoTrack && isTrackValid && !trackError && isLoaded;

  const { settings } = useMeetingRoomSettings();
  const { isDarkMode } = useMeetingRoomTheme({ theme: settings.appearance.theme });
  const isDarkerGradient = settings.appearance.gradient === "darker" && isDarkMode;
  const localGradientPreference = participant.isLocal ? settings.appearance.profileGradient : undefined;

  const participantColors = useMemo(() => getParticipantColor(participant.displayName || participant.id, localGradientPreference), [localGradientPreference, participant.displayName, participant.id]);
  const participantGradient = useMemo(() => (isDarkerGradient ? `linear-gradient(180deg, ${participantColors.primary} 0%, ${participantColors.secondary} 100%)` : getParticipantGradient(participant.displayName || participant.id, localGradientPreference)), [localGradientPreference, participant.displayName, participant.id, isDarkerGradient, participantColors]);

  return (
    <div
      className={cn(
        "relative overflow-hidden rounded-2xl border-2 border-transparent outline-none transition-all duration-300",
        aspectRatioClasses[aspectRatio],
        pinned && "ring-2",
        participant.isSpeaking && !prefersReducedMotion && "chalk-animate-harmonic-pulse",
        participant.isSpeaking && prefersReducedMotion && "border-solid",
        onClick && "cursor-pointer",
        className,
      )}
      style={
        {
          ...style,
          "--chalk-accent-speaking": participantColors.primary,
          "--chalk-accent-speaking-glow": `${participantColors.primary}4D`, // 30% opacity hex
          borderColor: participant.isSpeaking && prefersReducedMotion ? participantColors.primary : undefined,
          ...(pinned ? { "--tw-ring-color": `${participantColors.primary}80` } : {}),
        } as React.CSSProperties
      }
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      data-tour={participant.isLocal ? "local-video" : "video-grid"}
      role="region"
      aria-label={`Video tile for ${participant.displayName}`}
    >
      {/* Video element (always rendered, visibility controlled by CSS) */}
      <video ref={videoRef} autoPlay playsInline muted onLoadedData={handleVideoLoaded} className={cn("h-full w-full object-cover transition-opacity duration-500", mirror && "scale-x-[-1]", !showVideo ? "opacity-0" : "opacity-100")} />

      {/* Avatar background when video is off or loading */}
      {!showVideo && showAvatar && (
        <div className="absolute inset-0 flex items-center justify-center transition-opacity duration-300 bg-[var(--chalk-bg-tile)]" style={{ backgroundImage: participantGradient }}>
          <Avatar name={participant.displayName} src={participant.avatarUrl} size="xl" className="opacity-90" gradientPreference={localGradientPreference} />
        </div>
      )}

      {children}

      {/* Compact bottom-left info chip */}
      {(showName || showStatus) && (
        <div className="absolute bottom-2 left-2 right-2 pointer-events-none">
          <div
            className="inline-flex items-center gap-1.5 px-1.5 py-1 rounded-full bg-zinc-950/80 border border-white/5"
          >
            {/* Small avatar when video is off */}
            {!showVideo && showAvatar && <Avatar name={participant.displayName} src={participant.avatarUrl} size="xs" gradientPreference={localGradientPreference} />}

            {/* Name */}
            {showName && <span className="text-xs font-medium text-white truncate max-w-[100px]">{participant.displayName}</span>}

            {/* Status icons inline */}
            {showStatus && (
              <div className="flex items-center gap-1 ml-auto">
                {participant.isMuted && (
                  <div className="rounded-full bg-red-500/80 p-0.5">
                    <MicrophoneOff01Icon size={10} className="text-white" />
                  </div>
                )}
                {participant.isHandRaised && (
                  <div className={cn("rounded-full bg-amber-500/80 p-0.5", !prefersReducedMotion && "chalk-animate-hand-bounce")}>
                    <HandIcon size={10} className="text-white" />
                  </div>
                )}
                {participant.isScreenSharing && (
                  <div className="rounded-full p-0.5" style={{ backgroundColor: `${participantColors.primary}CC` }}>
                    <Monitor01Icon size={10} className="text-white" />
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

VideoTile.displayName = "VideoTile";
