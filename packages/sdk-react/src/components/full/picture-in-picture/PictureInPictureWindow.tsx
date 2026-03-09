import { useEffect, useRef, useMemo } from "react";

import { cn } from "../../../utils/cn";
import { getParticipantGradient } from "../../../utils/colorGenerator";
import { Avatar, ControlButton } from "../../atomic";
import { HandIcon, Home01Icon, Microphone01Icon, MicrophoneOff01Icon, Monitor01Icon, MonitorOffIcon, Video01Icon, VideoOffIcon, CallEnd01Icon } from "../../../utils/icons";
import type { PictureInPictureControls, PictureInPicturePhase, PictureInPictureSource } from "./types";

interface PictureInPictureWindowProps {
  phase: PictureInPicturePhase;
  roomName?: string;
  displayName?: string;
  source: PictureInPictureSource | null;
  previewSource?: PictureInPictureSource | null;
  controls: PictureInPictureControls;
  onReturnToTab: () => void;
}

function PictureInPictureStage({ source, className }: { source: PictureInPictureSource | null; className?: string; hideOverlay?: boolean }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const hasVideo = Boolean(source?.videoTrack);

  const participantGradient = useMemo(() => getParticipantGradient(source?.title || source?.id || "unknown"), [source?.title, source?.id]);

  useEffect(() => {
    const videoElement = videoRef.current;
    const track = source?.videoTrack;

    if (!videoElement) return;
    if (!track || track.readyState === "ended") {
      videoElement.srcObject = null;
      return;
    }

    videoElement.srcObject = new MediaStream([track]);
    void videoElement.play().catch(() => {});

    return () => {
      videoElement.srcObject = null;
    };
  }, [source?.videoTrack]);

  return (
    <div className={cn("relative flex-1 bg-[var(--chalk-bg-tile)] overflow-hidden", className)}>
      {hasVideo ? (
        <video ref={videoRef} autoPlay playsInline muted className={cn("h-full w-full", source?.kind === "screen-share" ? "object-contain bg-black" : "object-cover")} />
      ) : (
        <div className="absolute inset-0 flex items-center justify-center transition-opacity duration-300" style={{ backgroundImage: participantGradient }}>
          <Avatar name={source?.title ?? "Guest"} src={source?.avatarUrl} size="xl" className="opacity-90 shadow-[0_8px_32px_rgba(0,0,0,0.5)]" />
        </div>
      )}
    </div>
  );
}

export function PictureInPictureWindow({ phase, source, previewSource, controls, onReturnToTab }: PictureInPictureWindowProps) {
  const actionButtons = useMemo(() => {
    const base = [
      {
        key: "mute",
        label: controls.isMuted ? "Unmute" : "Mute",
        icon: controls.isMuted ? <MicrophoneOff01Icon size={18} /> : <Microphone01Icon size={18} />,
        active: !controls.isMuted,
        danger: controls.isMuted,
        onClick: controls.onToggleMute,
      },
      {
        key: "video",
        label: controls.isVideoEnabled ? "Stop Video" : "Start Video",
        icon: controls.isVideoEnabled ? <Video01Icon size={18} /> : <VideoOffIcon size={18} />,
        active: controls.isVideoEnabled,
        danger: !controls.isVideoEnabled,
        onClick: controls.onToggleVideo,
      },
    ];

    if (phase === "prejoin") {
      return [...base, { key: "return", label: "Return", icon: <Home01Icon size={18} />, active: true, danger: false, activeClassName: "bg-[var(--secondary)] text-[var(--foreground)]", onClick: onReturnToTab }];
    }

    return [
      ...base,
      controls.enableScreenShare && {
        key: "screenshare",
        label: "Share",
        icon: controls.isScreenSharing ? <MonitorOffIcon size={18} /> : <Monitor01Icon size={18} />,
        active: controls.isScreenSharing,
        danger: false,
        onClick: controls.onToggleScreenShare,
      },
      controls.enableHandRaise && {
        key: "handraise",
        label: "Hand",
        icon: <HandIcon size={18} />,
        active: controls.isHandRaised,
        danger: false,
        onClick: controls.onToggleHandRaise,
      },
      { key: "return", label: "Return", icon: <Home01Icon size={18} />, active: true, danger: false, activeClassName: "bg-[var(--secondary)] text-[var(--foreground)]", onClick: onReturnToTab },
      controls.onLeave && { key: "leave", label: "Leave", icon: <CallEnd01Icon size={18} />, active: true, danger: true, onClick: controls.onLeave },
    ].filter((btn): btn is Exclude<typeof btn, false | undefined | null> => Boolean(btn));
  }, [controls, onReturnToTab, phase]);

  return (
    <div className="flex h-screen w-full flex-col bg-background text-foreground chalk-theme-transition">
      <div className="relative flex-1 overflow-hidden rounded-2xl border border-border bg-[var(--chalk-bg-tile)] m-3 mb-0 shadow-2xl">
        <PictureInPictureStage source={source} className="h-full w-full border-0" />

        {source?.isMuted && (
          <div className="absolute right-4 top-4 flex h-8 w-8 items-center justify-center rounded-full bg-black/60 shadow-lg backdrop-blur-md">
            <MicrophoneOff01Icon size={16} className="text-white" />
          </div>
        )}

        <div className="absolute inset-x-0 bottom-0 pointer-events-none bg-gradient-to-t from-black/80 via-black/20 to-transparent p-4 pb-5 pt-8">
          <p className="max-w-full truncate text-[15px] font-medium text-white drop-shadow-md">{source?.title ?? "Waiting for video"}</p>
        </div>

        {phase === "meeting" && previewSource && (
          <div className="absolute right-4 bottom-4 h-28 w-20 overflow-hidden rounded-xl border border-white/10 shadow-xl bg-black/40 backdrop-blur-md">
            <PictureInPictureStage source={previewSource} className="h-full w-full" />
          </div>
        )}
      </div>
      <div className="flex shrink-0 items-center justify-center gap-2 pb-4 pt-4 px-4 bg-background">
        {actionButtons.map((btn) => (
          <ControlButton key={btn.key} icon={btn.icon} label={btn.label} active={btn.active} danger={"danger" in btn ? btn.danger : false} onClick={btn.onClick} size="md" activeClassName={"activeClassName" in btn ? btn.activeClassName : undefined} />
        ))}
      </div>
    </div>
  );
}
