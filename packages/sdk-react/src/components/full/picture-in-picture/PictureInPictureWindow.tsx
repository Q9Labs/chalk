import { useEffect, useRef, useMemo } from "react";

import { cn } from "../../../utils/cn";
import { getParticipantGradient, getParticipantThemeVariables } from "../../../utils/colorGenerator";
import { Avatar, ControlButton } from "../../atomic";
import { DeviceControlButton } from "../../composite/DeviceControlButton";
import { HandIcon, Home01Icon, MicrophoneOff01Icon, Monitor01Icon, MonitorOffIcon, CallEnd01Icon } from "../../../utils/icons";
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

function Equalizer() {
  return (
    <div className="flex items-end gap-[2px] h-3 ml-2 shrink-0">
      <div className="w-[3px] bg-white rounded-full h-full origin-bottom" style={{ animation: "pip-eq 0.8s ease-in-out infinite" }} />
      <div className="w-[3px] bg-white rounded-full h-full origin-bottom" style={{ animation: "pip-eq 0.8s ease-in-out infinite 0.2s" }} />
      <div className="w-[3px] bg-white rounded-full h-full origin-bottom" style={{ animation: "pip-eq 0.8s ease-in-out infinite 0.4s" }} />
      <style>{`
        @keyframes pip-eq {
          0%, 100% { transform: scaleY(0.4); }
          50% { transform: scaleY(1); }
        }
      `}</style>
    </div>
  );
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
    <div className={cn("relative flex-1 bg-[var(--chalk-bg-tile)] overflow-hidden transition-all duration-300", source?.isSpeaking && "ring-2 ring-emerald-500/80 shadow-[0_0_24px_rgba(16,185,129,0.3)]", className)}>
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
    const base: any[] = [];

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
        activeClassName: "bg-primary text-primary-foreground hover:bg-primary/90",
        onClick: controls.onToggleScreenShare,
      },
      controls.enableHandRaise && {
        key: "handraise",
        label: "Hand",
        icon: <HandIcon size={18} />,
        active: controls.isHandRaised,
        danger: false,
        activeClassName: "bg-primary text-primary-foreground hover:bg-primary/90",
        onClick: controls.onToggleHandRaise,
      },
      { key: "return", label: "Return", icon: <Home01Icon size={18} />, active: true, danger: false, activeClassName: "bg-[var(--secondary)] text-[var(--foreground)]", onClick: onReturnToTab },
      controls.onLeave && { key: "leave", label: "Leave", icon: <CallEnd01Icon size={18} />, active: true, danger: true, onClick: controls.onLeave },
    ].filter((btn): btn is Exclude<typeof btn, false | undefined | null> => Boolean(btn));
  }, [controls, onReturnToTab, phase]);

  const participantThemeVariables = useMemo(() => getParticipantThemeVariables(source?.title ?? source?.id ?? "unknown"), [source?.title, source?.id]);

  return (
    <div className="flex h-screen w-full flex-col bg-background text-foreground chalk-theme-transition" style={participantThemeVariables as React.CSSProperties}>
      <div className="relative flex-1 overflow-hidden rounded-2xl border border-border bg-[var(--chalk-bg-tile)] m-3 mb-0 shadow-2xl">
        <PictureInPictureStage source={source} className="h-full w-full border-0" />

        <div className="absolute inset-x-0 bottom-0 pointer-events-none bg-gradient-to-t from-black/80 via-black/20 to-transparent p-4 pb-5 pt-8 flex items-center justify-between">
          <div className="flex items-center min-w-0">
            <p className="max-w-[140px] truncate text-[15px] font-medium text-white drop-shadow-md">{source?.title ?? "Waiting for video"}</p>
            {source?.isSpeaking && !source?.isMuted && <Equalizer />}
            {source?.isMuted && (
              <div className="rounded-full bg-red-500/80 p-0.5 ml-2">
                <MicrophoneOff01Icon size={12} className="text-white" />
              </div>
            )}
          </div>
        </div>

        {phase === "meeting" && previewSource && (
          <div className="absolute right-4 bottom-4 h-28 w-20 overflow-hidden rounded-xl border border-white/10 shadow-xl bg-black/40 backdrop-blur-md">
            <PictureInPictureStage source={previewSource} className="h-full w-full" />
          </div>
        )}
      </div>
      <div className="flex shrink-0 items-center justify-center gap-2 pb-4 pt-4 px-4 bg-background">
        <DeviceControlButton
          type="mic"
          isActive={!controls.isMuted}
          onToggle={controls.onToggleMute ?? (() => {})}
          devices={controls.audioInputDevices ?? []}
          selectedDeviceId={controls.selectedAudioInput}
          onDeviceChange={controls.onAudioInputChange ?? (() => {})}
          secondaryDevices={controls.audioOutputDevices ?? []}
          selectedSecondaryDeviceId={controls.selectedAudioOutput}
          onSecondaryDeviceChange={controls.onAudioOutputChange}
          orientation="up"
          haptic="medium"
          size="sm"
        />
        <DeviceControlButton
          type="video"
          isActive={!!controls.isVideoEnabled}
          onToggle={controls.onToggleVideo ?? (() => {})}
          devices={controls.videoInputDevices ?? []}
          selectedDeviceId={controls.selectedVideoInput}
          onDeviceChange={controls.onVideoInputChange ?? (() => {})}
          orientation="up"
          haptic="medium"
          size="sm"
        />
        {actionButtons.map((btn) => (
          <ControlButton key={btn.key} icon={btn.icon} label={btn.label} active={btn.active} danger={"danger" in btn ? btn.danger : false} onClick={btn.onClick} size="sm" activeClassName={"activeClassName" in btn ? btn.activeClassName : undefined} />
        ))}
      </div>
    </div>
  );
}
