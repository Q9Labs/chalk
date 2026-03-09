import { useEffect, useRef, useMemo } from "react";

import { cn } from "../../../utils/cn";
import { getParticipantGradient } from "../../../utils/colorGenerator";
import { Avatar, ControlButton } from "../../atomic";
import { Edit02Icon, HandIcon, Home01Icon, Message01Icon, Microphone01Icon, MicrophoneOff01Icon, Monitor01Icon, MonitorOffIcon, Video01Icon, VideoOffIcon, CallEnd01Icon } from "../../../utils/icons";
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

function PictureInPictureStage({ source, className, hideOverlay }: { source: PictureInPictureSource | null; className?: string; hideOverlay?: boolean }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const hasVideo = Boolean(source?.videoTrack);

  const participantGradient = useMemo(() => getParticipantGradient(source?.title || source?.id || "unknown"), [source?.title, source?.id]);

  useEffect(() => {
    const videoElement = videoRef.current;
    const track = source?.videoTrack;

    if (!videoElement) {
      return;
    }

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
    <div className={cn("relative flex-1 overflow-hidden", className)}>
      {hasVideo ? (
        <video ref={videoRef} autoPlay playsInline muted className={cn("h-full w-full", source?.kind === "screen-share" ? "object-contain bg-black" : "object-cover")} />
      ) : (
        <div className="absolute inset-0 flex items-center justify-center bg-[var(--chalk-bg-tile)] transition-opacity duration-300" style={{ backgroundImage: participantGradient }}>
          <Avatar name={source?.title ?? "Guest"} src={source?.avatarUrl} size="xl" className="opacity-90 shadow-[0_8px_32px_rgba(0,0,0,0.5)]" />
        </div>
      )}
      {!hideOverlay ? (
        <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 via-black/20 to-transparent p-4">
          <div className="flex items-end justify-between gap-3">
            <div className="min-w-0">
              <p className="truncate text-[15px] font-medium text-white drop-shadow-md">{source?.title ?? "Waiting for video"}</p>
            </div>
            {source?.isMuted ? <div className="rounded-full bg-black/60 shadow-lg backdrop-blur-md px-2 py-1 text-[10px] font-medium uppercase tracking-[0.18em] text-white/80">Muted</div> : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function PictureInPictureWindow({ phase, source, previewSource, controls, onReturnToTab }: PictureInPictureWindowProps) {
  const actionButtons = useMemo(() => {
    if (phase === "prejoin") {
      return [
        {
          key: "mute",
          label: controls.isMuted ? "Unmute" : "Mute",
          icon: controls.isMuted ? <MicrophoneOff01Icon size={18} /> : <Microphone01Icon size={18} />,
          active: !controls.isMuted,
          onClick: controls.onToggleMute,
        },
        {
          key: "video",
          label: controls.isVideoEnabled ? "Stop Video" : "Start Video",
          icon: controls.isVideoEnabled ? <Video01Icon size={18} /> : <VideoOffIcon size={18} />,
          active: controls.isVideoEnabled,
          onClick: controls.onToggleVideo,
        },
        {
          key: "return",
          label: "Return to tab",
          icon: <Home01Icon size={18} />,
          active: true,
          activeClassName: "bg-white/12 text-white hover:bg-white/18 border border-white/10",
          onClick: onReturnToTab,
        },
      ];
    }

    return [
      {
        key: "mute",
        label: controls.isMuted ? "Unmute" : "Mute",
        icon: controls.isMuted ? <MicrophoneOff01Icon size={18} /> : <Microphone01Icon size={18} />,
        active: !controls.isMuted,
        onClick: controls.onToggleMute,
      },
      {
        key: "video",
        label: controls.isVideoEnabled ? "Stop Video" : "Start Video",
        icon: controls.isVideoEnabled ? <Video01Icon size={18} /> : <VideoOffIcon size={18} />,
        active: controls.isVideoEnabled,
        onClick: controls.onToggleVideo,
      },
      controls.enableScreenShare && controls.onToggleScreenShare
        ? {
            key: "screenshare",
            label: controls.isScreenSharing ? "Stop Share" : "Share Screen",
            icon: controls.isScreenSharing ? <MonitorOffIcon size={18} /> : <Monitor01Icon size={18} />,
            active: controls.isScreenSharing,
            onClick: controls.onToggleScreenShare,
          }
        : null,
      controls.enableHandRaise && controls.onToggleHandRaise
        ? {
            key: "handraise",
            label: controls.isHandRaised ? "Lower Hand" : "Raise Hand",
            icon: <HandIcon size={18} />,
            active: controls.isHandRaised,
            onClick: controls.onToggleHandRaise,
          }
        : null,
      controls.enableWhiteboard && controls.onToggleWhiteboard
        ? {
            key: "whiteboard",
            label: "Whiteboard",
            icon: <Edit02Icon size={18} />,
            active: controls.isWhiteboardOpen,
            onClick: controls.onToggleWhiteboard,
          }
        : null,
      controls.enableReactions && controls.onOpenReactions
        ? {
            key: "reactions",
            label: "Reactions",
            icon: <Message01Icon size={18} />,
            active: false,
            activeClassName: "bg-white/12 text-white hover:bg-white/18 border border-white/10",
            onClick: controls.onOpenReactions,
          }
        : null,
      {
        key: "return",
        label: "Return to tab",
        icon: <Home01Icon size={18} />,
        active: true,
        activeClassName: "bg-white/12 text-white hover:bg-white/18 border border-white/10",
        onClick: onReturnToTab,
      },
      controls.onLeave
        ? {
            key: "leave",
            label: "Leave meeting",
            icon: <CallEnd01Icon size={18} />,
            active: true,
            activeClassName: "bg-[#ef4444] text-white hover:bg-[#dc2626] border border-transparent",
            onClick: controls.onLeave,
          }
        : null,
    ].filter(Boolean);
  }, [controls, onReturnToTab, phase]);

  return (
    <div className="flex h-screen w-full flex-col bg-background text-foreground chalk-theme-transition">
      {/* Video Stage Container */}
      <div className="relative flex-1 overflow-hidden rounded-[24px] border border-border bg-[var(--chalk-bg-tile)] m-3 mb-0 shadow-2xl">
        <PictureInPictureStage source={source} className="h-full w-full border-0" hideOverlay />

        {/* Top Right: Mute Indicator */}
        {source?.isMuted ? (
          <div className="absolute right-4 top-4 flex h-8 w-8 items-center justify-center rounded-full bg-black/60 shadow-lg backdrop-blur-md">
            <MicrophoneOff01Icon size={16} className="text-white" />
          </div>
        ) : null}

        {/* Preview overlay (like self-view) */}
        {phase === "meeting" && previewSource ? (
          <div className="pointer-events-none absolute bottom-4 right-4 z-10 h-28 w-20 overflow-hidden rounded-xl border border-white/10 bg-black/40 shadow-2xl backdrop-blur-md">
            <PictureInPictureStage source={previewSource} className="h-full w-full rounded-none border-0" hideOverlay />
          </div>
        ) : null}

        {/* Bottom Left: Display Name */}
        <div className="absolute bottom-4 left-5">
          <p className="max-w-[140px] truncate text-[15px] font-medium text-white drop-shadow-md">{source?.title ?? "Waiting for video"}</p>
        </div>
      </div>

      {/* Bottom Controls */}
      <div className="flex shrink-0 items-center justify-center gap-2 pb-4 pt-4 px-4 bg-background">
        {actionButtons.map((button) => (button ? <ControlButton key={button.key} icon={button.icon} label={button.label} active={button.active} onClick={button.onClick} size="md" activeClassName={button.activeClassName} /> : null))}
      </div>
    </div>
  );
}
