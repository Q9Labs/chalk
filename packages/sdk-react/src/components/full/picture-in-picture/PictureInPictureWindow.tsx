import { useEffect, useRef, useMemo, useState } from "react";

import { cn } from "../../../utils/cn";
import { getParticipantColor, getParticipantGradient, getParticipantThemeVariables, type ParticipantGradientPreference } from "../../../utils/colorGenerator";
import { Avatar, ControlButton } from "../../atomic";
import { DeviceControlButton, ReactionPicker } from "../../composite";
import { HandIcon, Home01Icon, Microphone01Icon, MicrophoneOff01Icon, Monitor01Icon, MonitorOffIcon, Video01Icon, VideoOffIcon, CallEnd01Icon, ThumbsUpIcon, Cancel01Icon, RefreshIcon, ArrowLeft01Icon } from "../../../utils/icons";
import { useMeetingRoomSettings } from "../../../hooks/useMeetingRoomSettings";
import { useMeetingRoomTheme } from "../meeting-room/useMeetingRoomTheme";
import { LoadingScreen } from "../LoadingScreen";
import type { PictureInPictureControls, PictureInPictureMeetingLayout, PictureInPicturePhase, PictureInPictureSource } from "./types";

interface PictureInPictureWindowProps {
  phase: PictureInPicturePhase;
  roomName?: string;
  displayName?: string;
  source: PictureInPictureSource | null;
  previewSource?: PictureInPictureSource | null;
  participantSources?: PictureInPictureSource[];
  meetingLayout?: PictureInPictureMeetingLayout;
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

function isTransparentBoardColor(color: unknown) {
  if (typeof color !== "string") {
    return true;
  }

  const normalized = color.trim().toLowerCase();
  return normalized === "" || normalized === "transparent" || normalized === "#0000" || normalized === "#00000000" || normalized === "rgba(0,0,0,0)" || normalized === "rgba(0, 0, 0, 0)";
}

function WhiteboardPictureInPictureStage({
  snapshot,
  className,
}: {
  snapshot: NonNullable<PictureInPictureSource["whiteboardSnapshot"]>;
  className?: string;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  const backgroundColor = isTransparentBoardColor(snapshot.appState.viewBackgroundColor)
    ? "#ffffff"
    : String(snapshot.appState.viewBackgroundColor);

  useEffect(() => {
    let isCancelled = false;

    const renderWhiteboard = async () => {
      const container = containerRef.current;
      if (!container) {
        return;
      }

      const { exportToCanvas, getNonDeletedElements } = await import("@excalidraw/excalidraw");

      const canvas = await exportToCanvas({
        elements: getNonDeletedElements(snapshot.elements as never[]),
        appState: {
          ...(snapshot.appState as Record<string, unknown>),
          exportBackground: true,
          exportWithDarkMode: false,
          theme: "light",
          viewBackgroundColor: backgroundColor,
        },
        files: snapshot.files as never,
        exportPadding: 0,
        getDimensions: () => ({
          width: Math.max(container.clientWidth, 320),
          height: Math.max(container.clientHeight, 240),
          scale: 1,
        }),
      });

      if (!isCancelled) {
        setDataUrl(canvas.toDataURL("image/png"));
      }
    };

    void renderWhiteboard();

    return () => {
      isCancelled = true;
    };
  }, [backgroundColor, snapshot]);

  return (
    <div ref={containerRef} className={cn("relative flex-1 overflow-hidden", className)} style={{ backgroundColor }}>
      {dataUrl ? <img src={dataUrl} alt="Whiteboard" className="h-full w-full object-contain" style={{ backgroundColor }} /> : <div className="absolute inset-0" style={{ backgroundColor }} />}
    </div>
  );
}

function getSourceGradientPreference(source: PictureInPictureSource | null, localParticipantGradientPreference?: ParticipantGradientPreference) {
  return source?.isLocal ? localParticipantGradientPreference : undefined;
}

function PictureInPictureStage({
  source,
  className,
  gradientPreference,
}: {
  source: PictureInPictureSource | null;
  className?: string;
  hideOverlay?: boolean;
  gradientPreference?: ParticipantGradientPreference;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const hasVideo = Boolean(source?.videoTrack);
  const { settings } = useMeetingRoomSettings();
  const { isDarkMode } = useMeetingRoomTheme({ theme: settings.appearance.theme });
  const isDarkerGradient = settings.appearance.gradient === "darker" && isDarkMode;
  const participantColors = useMemo(() => getParticipantColor(source?.title || source?.id || "unknown", gradientPreference), [gradientPreference, source?.title, source?.id]);

  const participantGradient = useMemo(
    () => (isDarkerGradient ? `linear-gradient(180deg, ${participantColors.primary} 0%, ${participantColors.secondary} 100%)` : getParticipantGradient(source?.title || source?.id || "unknown", gradientPreference)),
    [gradientPreference, source?.title, source?.id, isDarkerGradient, participantColors],
  );

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
    <div className={cn("relative flex-1 bg-[var(--chalk-bg-tile)] overflow-hidden transition-all duration-300", className)}>
      {source?.kind === "whiteboard" && source.whiteboardSnapshot ? (
        <WhiteboardPictureInPictureStage snapshot={source.whiteboardSnapshot} className="h-full w-full" />
      ) : hasVideo ? (
        <video ref={videoRef} autoPlay playsInline muted className={cn("h-full w-full", source?.kind === "screen-share" ? "object-contain bg-black" : "object-cover")} />
      ) : (
        <div className="absolute inset-0 flex items-center justify-center transition-opacity duration-300" style={{ backgroundImage: participantGradient }}>
          <Avatar name={source?.title ?? "Guest"} src={source?.avatarUrl} size="xl" className="opacity-90" gradientPreference={gradientPreference} />
        </div>
      )}
    </div>
  );
}

function PictureInPictureTile({
  source,
  className,
  gradientPreference,
}: {
  source: PictureInPictureSource | null;
  className?: string;
  gradientPreference?: ParticipantGradientPreference;
}) {
  if (!source) {
    return null;
  }

  const isPlaceholder = source.kind === "placeholder";

  return (
    <div
      className={cn(
        "relative min-h-0 overflow-hidden rounded-2xl border border-white/10 bg-[var(--chalk-bg-tile)] shadow-lg transition-all duration-300",
        source.isSpeaking && !source.isMuted && "ring-2 ring-emerald-500/80 shadow-[0_0_24px_rgba(16,185,129,0.2)]",
        className,
      )}
      role="group"
      aria-label={isPlaceholder ? `PiP overflow ${source.title}` : `PiP tile for ${source.title}`}
      data-testid="pip-tile"
      data-kind={source.kind}
    >
      {isPlaceholder ? (
        <div
          className="absolute inset-0 flex flex-col items-center justify-center px-4 text-center"
          style={{
            background:
              "radial-gradient(circle at top, var(--primary) 0%, transparent 65%), linear-gradient(180deg, rgba(255,255,255,0.06), rgba(255,255,255,0.02))",
          }}
        >
          <p className="text-4xl font-semibold tracking-tight text-white">{source.title}</p>
          <p className="mt-1 text-xs uppercase tracking-[0.2em] text-white/60">{source.subtitle ?? "more"}</p>
        </div>
      ) : (
        <>
          <PictureInPictureStage source={source} className="absolute inset-0 h-full w-full border-0" gradientPreference={gradientPreference} />
          <div className="absolute bottom-2 left-2 right-2 pointer-events-none">
            <div className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-white/5 bg-zinc-950/80 px-1.5 py-1">
              {!source.videoTrack && <Avatar name={source.title} src={source.avatarUrl} size="xs" gradientPreference={gradientPreference} />}
              <span className="max-w-[96px] truncate text-xs font-medium text-white">{source.title}</span>
              {source.subtitle ? <span className="text-[11px] text-white/70">{source.subtitle}</span> : null}
              {source.isSpeaking && !source.isMuted ? <Equalizer /> : null}
              <div className="ml-auto flex items-center gap-1">
                {source.isMuted && (
                  <div className="rounded-full bg-red-500/80 p-0.5">
                    <MicrophoneOff01Icon size={10} className="text-white" />
                  </div>
                )}
                {source.isHandRaised && (
                  <div className="rounded-full bg-amber-500/80 p-0.5">
                    <HandIcon size={10} className="text-white" />
                  </div>
                )}
                {source.kind === "screen-share" && (
                  <div className="rounded-full bg-white/15 p-0.5">
                    <Monitor01Icon size={10} className="text-white" />
                  </div>
                )}
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function getMeetingLayoutClass(layout: PictureInPictureMeetingLayout, count: number) {
  if (layout === "split") {
    return "grid-cols-2 grid-rows-1";
  }

  if (layout === "grid") {
    return "grid-cols-2 grid-rows-2";
  }

  if (layout === "single" && count <= 1) {
    return "grid-cols-1 grid-rows-1";
  }

  return "grid-cols-2 grid-rows-2";
}

function getPictureInPictureTileKey(source: PictureInPictureSource, index: number) {
  return `${source.kind}:${source.id}:${index}`;
}

function MeetingPictureInPictureLayout({
  source,
  participantSources,
  meetingLayout,
  localParticipantGradientPreference,
}: {
  source: PictureInPictureSource | null;
  participantSources: PictureInPictureSource[];
  meetingLayout: PictureInPictureMeetingLayout;
  localParticipantGradientPreference?: ParticipantGradientPreference;
}) {
  if (meetingLayout === "screen-share") {
    return (
      <div className="flex h-full min-h-0 gap-3 overflow-hidden p-3" data-testid="pip-layout" data-layout="screen-share">
        <PictureInPictureTile source={source} className="min-w-0 flex-1 shadow-2xl" gradientPreference={getSourceGradientPreference(source, localParticipantGradientPreference)} />
        {participantSources.length > 0 && (
          <div className="flex w-24 shrink-0 flex-col gap-3">
            {participantSources.map((participant, index) => (
              <PictureInPictureTile key={getPictureInPictureTileKey(participant, index)} source={participant} className="flex-1 shadow-xl" gradientPreference={getSourceGradientPreference(participant, localParticipantGradientPreference)} />
            ))}
          </div>
        )}
      </div>
    );
  }

  const tiles = participantSources.length > 0 ? participantSources : source ? [source] : [];

  return (
    <div
      className={cn("grid h-full min-h-0 gap-3 overflow-hidden p-3", getMeetingLayoutClass(meetingLayout, tiles.length))}
      data-testid="pip-layout"
      data-layout={meetingLayout}
    >
      {tiles.map((participant, index) => (
        <PictureInPictureTile
          key={getPictureInPictureTileKey(participant, index)}
          source={participant}
          gradientPreference={getSourceGradientPreference(participant, localParticipantGradientPreference)}
          className={cn(
            "shadow-xl",
            meetingLayout === "single" && "col-span-1 row-span-1",
            meetingLayout === "grid" && tiles.length === 3 && index === 0 && "row-span-2",
          )}
        />
      ))}
      {meetingLayout === "grid" && tiles.length === 3 && <div key="grid-filler" className="hidden" aria-hidden="true" />}
    </div>
  );
}

export function PictureInPictureWindow({ phase, source, previewSource, participantSources, meetingLayout = "single", controls, onReturnToTab }: PictureInPictureWindowProps) {
  const [isReactionPickerOpen, setIsReactionPickerOpen] = useState(false);
  const showErrorOverlay = phase !== "meeting" && Boolean(controls.errorMessage);
  const localParticipantGradientPreference = controls.localParticipantGradientPreference;
  const sourceGradientPreference = getSourceGradientPreference(source, localParticipantGradientPreference);
  const effectiveSourceGradientPreference = sourceGradientPreference ?? localParticipantGradientPreference;
  const actionButtons = useMemo(() => {
    const base = [
      {
        key: "mute",
        label: controls.isMuted ? "Unmute" : "Mute",
        icon: controls.isMuted ? <MicrophoneOff01Icon size={18} className="text-[#dc2626]" /> : <Microphone01Icon size={18} />,
        active: !controls.isMuted,
        danger: false,
        onClick: controls.onToggleMute,
      },
      {
        key: "video",
        label: controls.isVideoEnabled ? "Stop Video" : "Start Video",
        icon: controls.isVideoEnabled ? <Video01Icon size={18} /> : <VideoOffIcon size={18} className="text-[#dc2626]" />,
        active: controls.isVideoEnabled,
        danger: false,
        onClick: controls.onToggleVideo,
      },
    ];

    if (phase === "prejoin") {
      return [...base, { key: "return", label: "Return", icon: <Home01Icon size={18} />, active: false, danger: false, onClick: onReturnToTab }];
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
      controls.enableReactions && {
        key: "reactions",
        label: "React",
        icon: <ThumbsUpIcon size={18} className="text-[#FFD700]" />,
        active: isReactionPickerOpen,
        danger: false,
        onClick: () => setIsReactionPickerOpen(!isReactionPickerOpen),
      },
      { key: "return", label: "Return", icon: <Home01Icon size={18} />, active: false, danger: false, onClick: onReturnToTab },
      controls.onLeave && {
        key: "leave",
        label: "Leave",
        icon: <CallEnd01Icon size={18} />,
        active: true,
        danger: true,
        onClick: () => {
          onReturnToTab();
          controls.onLeave?.();
        },
      },
    ].filter((btn): btn is Exclude<typeof btn, false | undefined | null> => Boolean(btn));
  }, [controls, onReturnToTab, phase]);

  const participantThemeVariables = useMemo(
    () => getParticipantThemeVariables(source?.title ?? source?.id ?? "unknown", effectiveSourceGradientPreference) as React.CSSProperties & Record<"--primary" | "--primary-foreground", string>,
    [source?.title, source?.id, effectiveSourceGradientPreference],
  );
  const { settings } = useMeetingRoomSettings();
  const { isDarkMode } = useMeetingRoomTheme({ theme: settings.appearance.theme });
  const isDarkerGradient = settings.appearance.gradient === "darker" && isDarkMode;
  const reduceMotion = settings.appearance.reducedMotion;

  return (
    <div className="flex h-screen w-full flex-col bg-background text-foreground chalk-theme-transition relative overflow-hidden" style={participantThemeVariables as React.CSSProperties}>
      {phase !== "joining" && (
        <div className={cn("absolute inset-0 pointer-events-none z-0 overflow-hidden", isDarkMode ? "mix-blend-screen" : "mix-blend-multiply")}>
        {settings.appearance.ambientBackground && (
          <>
            <div
              className={cn("absolute -left-[25vw] -top-[25vh] h-[150vh] w-[150vw] transition-opacity duration-500", isDarkerGradient ? "opacity-10" : "opacity-40 dark:opacity-20", !reduceMotion && "animate-[spin_15s_linear_infinite]")}
              style={{
                background: "radial-gradient(ellipse at 40% 40%, var(--primary) 0%, transparent 60%)",
                filter: "blur(60px)",
              }}
            />
            <div
              className={cn("absolute -left-[25vw] -top-[25vh] h-[150vh] w-[150vw] transition-opacity duration-500", isDarkerGradient ? "opacity-5" : "opacity-30 dark:opacity-10", !reduceMotion && "animate-[spin_20s_linear_infinite_reverse]")}
              style={{
                background: "radial-gradient(ellipse at 60% 60%, var(--accent) 0%, transparent 60%)",
                filter: "blur(80px)",
              }}
            />
          </>
        )}
        </div>
      )}
      
      <div className="relative z-10 flex flex-1 flex-col overflow-hidden shadow-2xl transition-all duration-300">
        {phase === "meeting" && (
          <MeetingPictureInPictureLayout source={source} participantSources={participantSources ?? []} meetingLayout={meetingLayout} localParticipantGradientPreference={localParticipantGradientPreference} />
        )}
        {phase === "prejoin" && (
          <PictureInPictureStage source={source} className="absolute inset-0 h-full w-full border-0" gradientPreference={effectiveSourceGradientPreference} />
        )}

        {phase === "prejoin" && !showErrorOverlay && (
          <div className="absolute inset-x-0 top-12 flex flex-col items-center pointer-events-none z-10">
            <h2 className="text-white text-lg font-semibold drop-shadow-md">You're not in the room yet</h2>
          </div>
        )}

        {phase === "joining" && (
          <div className="absolute inset-0 z-50 bg-background flex items-center justify-center">
             <LoadingScreen 
               displayName={source?.title ?? "Guest"} 
               className="w-full h-full min-h-0" 
               message="Joining room..."
               supportingMessages={controls.loadingMessages}
               gradientPreference={effectiveSourceGradientPreference}
             />
          </div>
        )}

        {showErrorOverlay && (
          <div className="absolute inset-0 z-[60] flex items-center justify-center bg-slate-950/10 backdrop-blur-[6px] p-4 animate-in fade-in duration-300">
            <div 
              className="relative w-full max-w-[272px] overflow-hidden rounded-[24px] border border-white/10 bg-slate-950/72 px-4 pb-4 pt-3 text-center text-white shadow-[0_24px_60px_rgba(2,6,23,0.42)] animate-in zoom-in-95 slide-in-from-bottom-4 duration-500 ease-out"
              style={{
                backdropFilter: "blur(40px)",
              }}
            >
              <div
                className="pointer-events-none absolute inset-x-8 top-0 h-16 rounded-full opacity-80 blur-2xl"
                style={{ background: "radial-gradient(circle, rgba(239,68,68,0.16) 0%, transparent 72%)" }}
              />

              <div className="relative mb-3 flex justify-center">
                <div className="inline-flex h-10 w-10 items-center justify-center rounded-2xl border border-white/10 bg-white/5">
                  <Cancel01Icon size={18} className="text-red-400" />
                </div>
              </div>

              <div className="mb-3 space-y-1">
                <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-white/45">Join issue</p>
                <h2 className="text-[18px] font-semibold tracking-tight text-white">Unable to join room</h2>
              </div>
              <p className="mx-auto mb-4 max-w-[216px] text-[13px] leading-5 text-white/72">
                {controls.errorMessage}
              </p>

              <div className="mb-4 space-y-2 text-left">
                <div className="rounded-2xl border border-white/8 bg-white/[0.04] px-3 py-2.5">
                  <p className="text-[9px] font-semibold uppercase tracking-[0.18em] text-white/40">Technical details</p>
                  <p className="mt-1.5 text-[11px] leading-4 text-white/88">{controls.errorMessage}</p>
                </div>
                {controls.supportCode && (
                  <div className="rounded-2xl border border-white/8 bg-white/[0.04] px-3 py-2.5">
                    <p className="text-[9px] font-semibold uppercase tracking-[0.18em] text-white/40">Support code</p>
                    <p className="mt-1.5 text-[11px] font-mono leading-4 text-white/88 break-all">{controls.supportCode}</p>
                  </div>
                )}
              </div>

              <div className={cn("grid gap-2", controls.onJoin ? "grid-cols-2" : "grid-cols-1")}>
                {controls.onJoin && (
                  <button
                    onClick={controls.onJoin}
                    className="flex h-10 w-full items-center justify-center gap-2 rounded-2xl bg-primary text-xs font-semibold text-primary-foreground shadow-lg shadow-primary/20 transition-all hover:bg-primary/90 active:scale-95"
                  >
                    <RefreshIcon size={14} />
                    Try Again
                  </button>
                )}
                <button
                  onClick={onReturnToTab}
                  className="flex h-10 w-full items-center justify-center gap-2 rounded-2xl border border-white/10 bg-white/[0.03] text-xs font-semibold text-white transition-all hover:bg-white/[0.06] active:scale-95"
                >
                  <ArrowLeft01Icon size={14} />
                  Go Back
                </button>
              </div>
            </div>
          </div>
        )}

        {phase === "prejoin" && !showErrorOverlay && (
          <div className={cn("absolute inset-x-0 bottom-0 pointer-events-none bg-gradient-to-t from-black/80 via-black/20 to-transparent flex items-center justify-between", phase === "prejoin" ? "p-6 pb-20 pt-12" : "p-4 pb-5 pt-8")}>
            <div className="flex items-center min-w-0">
              <p className="max-w-[140px] truncate text-[15px] font-medium text-white drop-shadow-md">
                {phase === "prejoin" ? "" : (source?.title ?? "Waiting for video")}
              </p>
              {source?.isSpeaking && !source?.isMuted && <Equalizer />}
            </div>
          </div>
        )}

        {phase === "meeting" && meetingLayout === "single" && previewSource && (
          <div className="absolute right-4 bottom-4 h-28 w-20 overflow-hidden rounded-xl border border-border shadow-xl bg-muted/80">
            <PictureInPictureStage source={previewSource} className="h-full w-full" gradientPreference={getSourceGradientPreference(previewSource, localParticipantGradientPreference)} />
          </div>
        )}

        {isReactionPickerOpen && (
          <ReactionPicker
            isOpen={isReactionPickerOpen}
            onClose={() => setIsReactionPickerOpen(false)}
            onSelect={(emoji) => {
              controls.onSendReaction?.(emoji);
              setIsReactionPickerOpen(false);
            }}
            position="top"
            size="compact"
            className="absolute bottom-4 left-1/2 -translate-x-1/2"
          />
        )}

        {phase === "prejoin" && !showErrorOverlay && (
          <div className="absolute inset-x-0 bottom-6 flex justify-center items-center px-4 pointer-events-none">
            <div
              className={cn(
                "pointer-events-auto flex items-center gap-1.5 rounded-full border px-1.5 py-1.5 shadow-2xl",
                isDarkMode ? "dark border-white/10 bg-black/60 backdrop-blur-xl" : "border-black/[0.08] bg-white/80 backdrop-blur-[18px]",
              )}
            >
              <div className="flex items-center gap-1 px-1">
                <DeviceControlButton
                  type="mic"
                  isActive={!controls.isMuted}
                  onToggle={controls.onToggleMute ?? (() => {})}
                  devices={controls.audioInputDevices ?? []}
                  selectedDeviceId={controls.selectedAudioInput}
                  onDeviceChange={controls.onAudioInputChange ?? (() => {})}
                  className="!pointer-events-auto"
                  haptic="medium"
                  size="sm"
                />
                <DeviceControlButton
                  type="video"
                  isActive={Boolean(controls.isVideoEnabled)}
                  onToggle={controls.onToggleVideo ?? (() => {})}
                  devices={controls.videoInputDevices ?? []}
                  selectedDeviceId={controls.selectedVideoInput}
                  onDeviceChange={controls.onVideoInputChange ?? (() => {})}
                  className="!pointer-events-auto"
                  haptic="medium"
                  size="sm"
                />
              </div>
              <button
                onClick={controls.onJoin}
                className="h-9 rounded-full px-6 text-sm font-semibold shadow-lg transition-all hover:scale-105 active:scale-95"
                style={{
                  backgroundColor: participantThemeVariables["--primary"],
                  color: participantThemeVariables["--primary-foreground"],
                }}
              >
                Join Now
              </button>
            </div>
          </div>
        )}
      </div>
      
      {phase === "meeting" && (
        <div className="relative z-10 flex shrink-0 items-center justify-center gap-2 pb-3 pt-3 px-4 bg-background border-t border-border shadow-[0_-10px_40px_-15px_rgba(0,0,0,0.1)]">
          <div className="flex items-center gap-1 px-1.5 py-1 bg-muted rounded-full border border-border">
            {actionButtons
              .filter((b) => b.key === "mute" || b.key === "video")
              .map((btn) => (
                <ControlButton key={btn.key} icon={btn.icon} label={btn.label} active={btn.active} danger={"danger" in btn ? btn.danger : false} onClick={btn.onClick} size="sm" activeClassName={"activeClassName" in btn ? (btn as any).activeClassName : undefined} hideTooltip />
              ))}
          </div>

          {actionButtons.some((b) => b.key === "screenshare" || b.key === "handraise" || b.key === "reactions") && (
            <div className="flex items-center gap-1 px-1.5 py-1 bg-muted rounded-full border border-border">
              {actionButtons
                .filter((b) => b.key === "screenshare" || b.key === "handraise" || b.key === "reactions")
                .map((btn) => (
                  <ControlButton key={btn.key} icon={btn.icon} label={btn.label} active={btn.active} danger={"danger" in btn ? btn.danger : false} onClick={btn.onClick} size="sm" activeClassName={"activeClassName" in btn ? (btn as any).activeClassName : undefined} hideTooltip />
                ))}
            </div>
          )}

          <div className="flex items-center gap-1 px-1.5 py-1 bg-muted rounded-full border border-border">
            {actionButtons
              .filter((b) => b.key === "return" || b.key === "leave")
              .map((btn) => (
                <ControlButton
                  key={btn.key}
                  icon={btn.icon}
                  label={btn.label}
                  active={btn.active}
                  danger={"danger" in btn ? btn.danger : false}
                  onClick={btn.onClick}
                  size="sm"
                  activeClassName={"activeClassName" in btn ? (btn as any).activeClassName : undefined}
                  hideTooltip
                  className={btn.key === "leave" ? "h-9 w-auto px-5 rounded-full hover:scale-105 transition-transform" : undefined}
                />
              ))}
          </div>
        </div>
      )}
    </div>
  );
}
