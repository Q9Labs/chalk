import React, { useEffect, useMemo, useState } from "react";
import { cn } from "../../utils/cn";
import {
  CallEnd01Icon,
  CircleIcon,
  Edit02Icon,
  FileTextIcon,
  HandIcon,
  InformationCircleIcon,
  Message01Icon,
  Microphone01Icon,
  MicrophoneOff01Icon,
  Monitor01Icon,
  MonitorOffIcon,
  MoreHorizontalIcon,
  PictureInPictureIcon,
  Settings01Icon,
  SmileIcon,
  ThumbsUpIcon,
  UserGroupIcon,
  Video01Icon,
  VideoOffIcon,
} from "../../utils/icons";
import { ControlBarButton } from "../atomic";
import { getParticipantThemeVariables, type ParticipantGradientPreference } from "../../utils/colorGenerator";
import { DevicePopover } from "../device-popover/DevicePopover";

interface MediaDevice {
  deviceId: string;
  label: string;
  kind: MediaDeviceKind;
  groupId?: string;
}

const EMPTY_DETECTED_DEVICES = {
  audioinput: [] as MediaDevice[],
  audiooutput: [] as MediaDevice[],
  videoinput: [] as MediaDevice[],
};

function mergeDevices(...deviceGroups: ReadonlyArray<readonly MediaDevice[] | undefined>): MediaDevice[] {
  const devicesById = new Map<string, MediaDevice>();
  for (const deviceGroup of deviceGroups) {
    for (const device of deviceGroup ?? []) {
      const existing = devicesById.get(device.deviceId);
      if (!existing || (!existing.label && device.label)) devicesById.set(device.deviceId, device);
    }
  }
  return [...devicesById.values()];
}

function withSelectedDeviceFallback(devices: readonly MediaDevice[] | undefined, selectedDeviceId: string | undefined, fallbackLabel: string, kind: MediaDevice["kind"]): MediaDevice[] {
  if (devices?.length) return [...devices];
  return selectedDeviceId ? [{ deviceId: selectedDeviceId, label: fallbackLabel, kind }] : [];
}

export type ControlBarButtonName = "mic" | "video" | "screenshare" | "record" | "chat" | "participants" | "transcription" | "handraise" | "reactions" | "whiteboard" | "pip" | "settings" | "diagnostics" | "more" | "info" | "thumbsup" | "leave";

export interface ControlBarProps {
  position?: "bottom" | "top";
  placement?: "inline" | "floating";
  density?: "comfortable" | "compact";
  showLabels?: boolean;
  buttons?: ControlBarButtonName[];

  isMuted?: boolean;
  isVideoEnabled?: boolean;
  isScreenSharing?: boolean;
  isRecording?: boolean;
  isChatOpen?: boolean;
  isParticipantsOpen?: boolean;
  isTranscriptionEnabled?: boolean;
  isHandRaised?: boolean;
  isWhiteboardOpen?: boolean;
  isPictureInPictureActive?: boolean;
  duration?: number;
  unreadChatCount?: number;
  audioInputDevices?: readonly MediaDevice[];
  audioOutputDevices?: readonly MediaDevice[];
  videoInputDevices?: readonly MediaDevice[];
  selectedAudioInput?: string;
  selectedAudioOutput?: string;
  selectedVideoInput?: string;

  onToggleMute?: () => void;
  onToggleVideo?: () => void;
  onAudioInputChange?: (deviceId: string) => void;
  onAudioOutputChange?: (deviceId: string) => void;
  onVideoInputChange?: (deviceId: string) => void;
  onToggleScreenShare?: () => void;
  onToggleRecording?: () => void;
  onToggleChat?: () => void;
  onToggleParticipants?: () => void;
  onToggleTranscription?: () => void;
  onToggleHandRaise?: () => void;
  onToggleWhiteboard?: () => void;
  onTogglePictureInPicture?: () => Promise<void> | void;
  onOpenReactions?: () => void;
  onOpenSettings?: () => void;
  onOpenDiagnostics?: () => void;
  onOpenMore?: () => void;
  onOpenInfo?: () => void;
  onLeft?: () => void;

  participantColorSeed?: string;
  participantGradientPreference?: ParticipantGradientPreference;
  className?: string;
}

const DEFAULT_BUTTONS: ControlBarButtonName[] = ["mic", "video", "screenshare", "whiteboard", "handraise", "leave", "participants", "chat", "transcription", "thumbsup", "pip", "settings"];

const formatDuration = (seconds: number) => {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
  }
  return `${minutes}:${String(secs).padStart(2, "0")}`;
};

function FloatingControlBarButton({ icon, label, onClick, active = false, danger = false, badge }: { readonly icon: React.ReactNode; readonly label: string; readonly onClick?: () => void; readonly active?: boolean; readonly danger?: boolean; readonly badge?: number }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      aria-pressed={active}
      className={cn(
        "chalk-textured-surface relative flex h-[52px] w-[52px] shrink-0 items-center justify-center rounded-full border border-[var(--chalk-line)] bg-[var(--chalk-surface)] text-[var(--chalk-text)] shadow-[var(--chalk-shadow)] transition hover:-translate-y-0.5 hover:border-[var(--chalk-line)] hover:bg-[var(--chalk-stage)]",
        active && "border-[var(--chalk-line)] bg-[var(--chalk-accent)] text-[var(--chalk-accent-text)]",
        danger && "ml-2 border-[var(--chalk-danger)] bg-[var(--chalk-danger)] !text-[var(--chalk-accent-text)] hover:border-[var(--chalk-danger)] hover:bg-[var(--chalk-danger)]",
      )}
    >
      {icon}
      {badge && badge > 0 ? <span className="absolute top-1.5 right-1.5 grid min-h-[17px] min-w-[17px] place-items-center rounded-full bg-[var(--chalk-danger)] px-1 text-[10px] !text-[var(--chalk-accent-text)]">{badge > 99 ? "99+" : badge}</span> : null}
    </button>
  );
}

export const ControlBar = React.memo(
  ({
    isMuted = false,
    isVideoEnabled = true,
    isScreenSharing = false,
    isRecording = false,
    isChatOpen = false,
    isParticipantsOpen = false,
    isTranscriptionEnabled = false,
    isHandRaised = false,
    isWhiteboardOpen = false,
    isPictureInPictureActive = false,
    duration = 0,
    unreadChatCount = 0,
    audioInputDevices,
    audioOutputDevices,
    videoInputDevices,
    selectedAudioInput,
    selectedAudioOutput,
    selectedVideoInput,
    showLabels = false,
    placement = "inline",
    density = "comfortable",
    buttons,

    onToggleMute,
    onToggleVideo,
    onAudioInputChange,
    onAudioOutputChange,
    onVideoInputChange,
    onToggleScreenShare,
    onToggleRecording,
    onToggleChat,
    onToggleParticipants,
    onToggleTranscription,
    onToggleHandRaise,
    onToggleWhiteboard,
    onTogglePictureInPicture,
    onOpenReactions,
    onOpenSettings,
    onOpenDiagnostics,
    onOpenMore,
    onOpenInfo,
    onLeft,
    participantColorSeed,
    participantGradientPreference,

    className,
  }: ControlBarProps) => {
    const themeVariables = useMemo(() => getParticipantThemeVariables(participantColorSeed, participantGradientPreference), [participantColorSeed, participantGradientPreference]);
    const [detectedDevices, setDetectedDevices] = useState(EMPTY_DETECTED_DEVICES);
    const buttonsToRender = buttons ?? DEFAULT_BUTTONS;

    useEffect(() => {
      if (placement !== "floating" || density !== "comfortable" || !navigator.mediaDevices?.enumerateDevices) return;
      let cancelled = false;
      const syncDevices = async () => {
        try {
          const devices = (await navigator.mediaDevices.enumerateDevices()) as MediaDevice[];
          if (!cancelled) {
            setDetectedDevices({
              audioinput: devices.filter((device) => device.kind === "audioinput"),
              audiooutput: devices.filter((device) => device.kind === "audiooutput"),
              videoinput: devices.filter((device) => device.kind === "videoinput"),
            });
          }
        } catch {
          if (!cancelled) setDetectedDevices(EMPTY_DETECTED_DEVICES);
        }
      };
      void syncDevices();
      navigator.mediaDevices.addEventListener?.("devicechange", syncDevices);
      return () => {
        cancelled = true;
        navigator.mediaDevices.removeEventListener?.("devicechange", syncDevices);
      };
    }, [density, placement]);

    const effectiveAudioInputDevices = withSelectedDeviceFallback(mergeDevices(audioInputDevices, detectedDevices.audioinput), selectedAudioInput, "Current microphone", "audioinput");
    const effectiveAudioOutputDevices = withSelectedDeviceFallback(mergeDevices(audioOutputDevices, detectedDevices.audiooutput), selectedAudioOutput, "Current speaker", "audiooutput");
    const effectiveVideoInputDevices = withSelectedDeviceFallback(mergeDevices(videoInputDevices, detectedDevices.videoinput), selectedVideoInput, "Current camera", "videoinput");

    const showLeave = buttonsToRender.includes("leave");
    const mediaButtons = buttonsToRender.filter((b) => b === "mic" || b === "video" || b === "screenshare" || b === "record" || b === "whiteboard" || b === "handraise");
    const interactionButtons = buttonsToRender.filter((b) => b === "participants" || b === "chat" || b === "transcription" || b === "thumbsup" || b === "pip" || b === "reactions" || b === "settings" || b === "diagnostics" || b === "more" || b === "info");

    const renderButton = (type: ControlBarButtonName) => {
      switch (type) {
        case "mic":
          return <ControlBarButton key="mic" icon={isMuted ? <MicrophoneOff01Icon className="text-[var(--chalk-danger)]" /> : <Microphone01Icon />} label={isMuted ? "Unmute" : "Mute"} onClick={onToggleMute} active={!isMuted} showLabel={showLabels} data-tour="controls-mic" />;
        case "video":
          return <ControlBarButton key="video" icon={isVideoEnabled ? <Video01Icon /> : <VideoOffIcon className="text-[var(--chalk-danger)]" />} label={isVideoEnabled ? "Stop Video" : "Start Video"} onClick={onToggleVideo} active={isVideoEnabled} showLabel={showLabels} data-tour="controls-video" />;
        case "screenshare":
          return (
            <ControlBarButton
              key="screenshare"
              icon={isScreenSharing ? <MonitorOffIcon /> : <Monitor01Icon />}
              label={isScreenSharing ? "Stop Share" : "Share Screen"}
              onClick={onToggleScreenShare}
              active={isScreenSharing}
              activeClassName="bg-[var(--chalk-accent)] text-[var(--chalk-accent-text)] hover:bg-[var(--chalk-accent)]"
              showLabel={showLabels}
              data-tour="controls-screenshare"
            />
          );
        case "record":
          return <ControlBarButton key="record" icon={<CircleIcon className={isRecording ? "fill-current" : ""} />} label={isRecording ? "Stop Recording" : "Record"} onClick={onToggleRecording} active={isRecording} showLabel={showLabels} data-tour="controls-record" />;
        case "chat":
          return (
            <div key="chat" className="relative">
              <ControlBarButton icon={<Message01Icon />} label="Chat" onClick={onToggleChat} active={isChatOpen} activeClassName="bg-[var(--chalk-accent)] text-[var(--chalk-accent-text)] hover:bg-[var(--chalk-accent)]" showLabel={showLabels} data-tour="controls-chat" />
              {unreadChatCount > 0 && !isChatOpen && (
                <span className="absolute -top-1 -right-1 flex items-center justify-center min-w-[18px] h-[18px] px-1 text-[10px] font-semibold text-[var(--chalk-accent-text)] bg-[var(--chalk-danger)] rounded-full shadow-sm">{unreadChatCount > 99 ? "99+" : unreadChatCount}</span>
              )}
            </div>
          );
        case "participants":
          return (
            <ControlBarButton
              key="participants"
              icon={<UserGroupIcon />}
              label="People"
              onClick={onToggleParticipants}
              active={isParticipantsOpen}
              activeClassName="bg-[var(--chalk-accent)] text-[var(--chalk-accent-text)] hover:bg-[var(--chalk-accent)]"
              showLabel={showLabels}
              data-tour="controls-participants"
            />
          );
        case "transcription":
          return <ControlBarButton key="transcription" icon={<FileTextIcon />} label="Transcript" onClick={onToggleTranscription} active={isTranscriptionEnabled} activeClassName="bg-[var(--chalk-accent)] text-[var(--chalk-accent-text)] hover:bg-[var(--chalk-accent)]" showLabel={showLabels} />;
        case "handraise":
          return (
            <ControlBarButton key="handraise" icon={<HandIcon />} label={isHandRaised ? "Lower Hand" : "Raise Hand"} onClick={onToggleHandRaise} active={isHandRaised} activeClassName="bg-[var(--chalk-accent)] text-[var(--chalk-accent-text)] hover:bg-[var(--chalk-accent)]" showLabel={showLabels} />
          );
        case "reactions":
          return <ControlBarButton key="reactions" icon={<SmileIcon />} label="Reactions" onClick={onOpenReactions} showLabel={showLabels} />;
        case "whiteboard":
          return <ControlBarButton key="whiteboard" icon={<Edit02Icon />} label="Whiteboard" onClick={onToggleWhiteboard} active={isWhiteboardOpen} activeClassName="bg-[var(--chalk-accent)] text-[var(--chalk-accent-text)] hover:bg-[var(--chalk-accent)]" showLabel={showLabels} />;
        case "pip":
          if (!onTogglePictureInPicture) {
            return null;
          }
          return (
            <ControlBarButton
              key="pip"
              icon={<PictureInPictureIcon size={20} />}
              label={isPictureInPictureActive ? "Close picture in picture" : "Open picture in picture"}
              onClick={
                onTogglePictureInPicture
                  ? () => {
                      void onTogglePictureInPicture();
                    }
                  : undefined
              }
              active={isPictureInPictureActive}
              activeClassName="bg-[var(--chalk-accent)] text-[var(--chalk-accent-text)] hover:bg-[var(--chalk-accent)]"
              showLabel={showLabels}
            />
          );
        case "settings":
          return <ControlBarButton key="settings" icon={<Settings01Icon size={20} />} label="Settings" onClick={onOpenSettings} showLabel={showLabels} />;
        case "diagnostics":
          if (!onOpenDiagnostics) {
            return null;
          }
          return <ControlBarButton key="diagnostics" icon={<InformationCircleIcon size={20} />} label="Diagnostics" onClick={onOpenDiagnostics} showLabel={showLabels} />;
        case "more":
          return <ControlBarButton key="more" icon={<MoreHorizontalIcon />} label="More" onClick={onOpenMore} showLabel={showLabels} />;
        case "leave":
          return null; // Handled explicitly in the layout
        case "info":
          return <ControlBarButton key="info" icon={<InformationCircleIcon size={20} />} label="Info" onClick={onOpenInfo} noBorder />;
        case "thumbsup":
          return <ControlBarButton key="thumbsup" icon={<ThumbsUpIcon size={20} className="text-[var(--chalk-accent)]" />} label="Reactions" onClick={onOpenReactions} />;
        default:
          return null;
      }
    };

    // Compact floating layout matching the screenshot
    if (placement === "floating" && density === "compact") {
      return (
        <div
          className={cn("flex w-full flex-nowrap items-center gap-2 overflow-x-auto bg-transparent px-2 py-3 sm:px-4", className)}
          style={{
            ...(themeVariables as React.CSSProperties),
            paddingBottom: "max(12px, env(safe-area-inset-bottom))",
          }}
          role="toolbar"
          aria-label="Space controls"
        >
          <div className="flex items-center justify-center gap-1.5 min-w-min mx-auto">
            {/* Group 1: Media Controls */}
            <div className="order-1 flex shrink-0 items-center gap-1 rounded-[8px] border border-[var(--chalk-text)] bg-[var(--chalk-text)] p-1 shadow-[var(--chalk-shadow)]">
              <button
                type="button"
                onClick={onToggleMute}
                className={cn("flex h-[44px] w-[44px] items-center justify-center rounded-[6px] transition active:scale-95 sm:h-[46px] sm:w-[46px]", !isMuted ? "!text-[var(--chalk-accent-text)]" : "!text-[var(--chalk-danger-surface)]")}
                aria-label={isMuted ? "Unmute" : "Mute"}
                aria-pressed={!isMuted}
              >
                {isMuted ? <MicrophoneOff01Icon className="w-5 h-5" /> : <Microphone01Icon className="w-5 h-5" />}
              </button>

              <button
                type="button"
                onClick={onToggleVideo}
                className={cn("flex h-[44px] w-[44px] items-center justify-center rounded-[6px] transition active:scale-95 sm:h-[46px] sm:w-[46px]", isVideoEnabled ? "!text-[var(--chalk-accent-text)]" : "!text-[var(--chalk-danger-surface)]")}
                aria-label={isVideoEnabled ? "Stop Video" : "Start Video"}
                aria-pressed={isVideoEnabled}
              >
                {isVideoEnabled ? <Video01Icon className="w-5 h-5" /> : <VideoOffIcon className="w-5 h-5" />}
              </button>
            </div>

            {/* Group 2: Interactions */}
            <div className="order-3 flex shrink-0 items-center gap-1 rounded-[8px] border border-[var(--chalk-line)] bg-[var(--chalk-surface)] p-1 shadow-sm">
              {buttonsToRender.includes("handraise") && onToggleHandRaise && (
                <button
                  type="button"
                  onClick={onToggleHandRaise}
                  className={cn("flex h-[44px] w-[44px] items-center justify-center rounded-[6px] !text-[var(--chalk-text)] transition active:scale-95 sm:h-[46px] sm:w-[46px]", isHandRaised ? "bg-[var(--chalk-accent)]" : "")}
                  aria-label={isHandRaised ? "Lower hand" : "Raise hand"}
                  aria-pressed={isHandRaised}
                >
                  <HandIcon className="w-5 h-5" />
                </button>
              )}
              {buttonsToRender.includes("reactions") && onOpenReactions && (
                <button type="button" onClick={onOpenReactions} className="flex h-[44px] w-[44px] items-center justify-center rounded-[6px] !text-[var(--chalk-accent)] transition active:scale-95 sm:h-[46px] sm:w-[46px]" aria-label="Reactions">
                  <ThumbsUpIcon className="w-5 h-5" />
                </button>
              )}
              {buttonsToRender.includes("whiteboard") && onToggleWhiteboard && (
                <button
                  type="button"
                  onClick={onToggleWhiteboard}
                  className={cn("flex h-[44px] w-[44px] items-center justify-center rounded-[6px] !text-[var(--chalk-text)] transition active:scale-95 sm:h-[46px] sm:w-[46px]", isWhiteboardOpen ? "bg-[var(--chalk-danger-surface)]" : "")}
                  aria-label="Whiteboard"
                  aria-pressed={isWhiteboardOpen}
                >
                  <Edit02Icon className="w-5 h-5" />
                </button>
              )}
              {buttonsToRender.includes("participants") && onToggleParticipants && (
                <button
                  type="button"
                  onClick={onToggleParticipants}
                  className={cn("flex h-[44px] w-[44px] items-center justify-center rounded-[6px] !text-[var(--chalk-text)] transition active:scale-95 sm:h-[46px] sm:w-[46px]", isParticipantsOpen ? "bg-[var(--chalk-danger-surface)]" : "")}
                  aria-label="People"
                  aria-pressed={isParticipantsOpen}
                >
                  <UserGroupIcon className="w-5 h-5" />
                </button>
              )}
              {buttonsToRender.includes("chat") && onToggleChat && (
                <button
                  type="button"
                  onClick={onToggleChat}
                  className={cn("relative flex h-[44px] w-[44px] items-center justify-center rounded-[6px] !text-[var(--chalk-text)] transition active:scale-95 sm:h-[46px] sm:w-[46px]", isChatOpen ? "bg-[var(--chalk-danger-surface)]" : "")}
                  aria-label="Chat"
                  aria-pressed={isChatOpen}
                >
                  <Message01Icon className="w-5 h-5" />
                  {unreadChatCount > 0 && !isChatOpen ? (
                    <span className="absolute -top-1 -right-1 flex min-w-[18px] h-[18px] items-center justify-center rounded-full bg-[var(--chalk-danger)] px-1 text-[10px] font-semibold text-[var(--chalk-accent-text)]">{unreadChatCount > 99 ? "99+" : unreadChatCount}</span>
                  ) : null}
                </button>
              )}
            </div>

            {/* Group 3: More & Leave */}
            <div className="order-2 flex shrink-0 items-center gap-1 rounded-[8px] border border-[var(--chalk-line)] bg-[var(--chalk-surface)] p-1 shadow-sm">
              {buttonsToRender.includes("more") && (
                <button type="button" onClick={onOpenMore} className="flex h-[44px] w-[44px] items-center justify-center rounded-[6px] !text-[var(--chalk-text)] transition active:scale-95 sm:h-[46px] sm:w-[46px]" aria-label="More options">
                  <MoreHorizontalIcon className="w-5 h-5" />
                </button>
              )}
              <button type="button" onClick={onLeft} className="flex h-[44px] items-center justify-center rounded-[6px] border border-[var(--chalk-danger-surface)] bg-[var(--chalk-danger-surface)] px-4 !text-[var(--chalk-danger)] transition active:scale-95 sm:h-[46px]" aria-label="Leave space">
                <CallEnd01Icon className="w-5 h-5" />
              </button>
            </div>
          </div>
        </div>
      );
    }

    if (placement === "floating" && density === "comfortable") {
      const floatingButton = (type: ControlBarButtonName): React.ReactNode => {
        switch (type) {
          case "mic":
            return <FloatingControlBarButton key={type} icon={isMuted ? <MicrophoneOff01Icon /> : <Microphone01Icon />} label={isMuted ? "Unmute" : "Mute"} onClick={onToggleMute} active={!isMuted} />;
          case "video":
            return <FloatingControlBarButton key={type} icon={isVideoEnabled ? <Video01Icon /> : <VideoOffIcon />} label="Camera" onClick={onToggleVideo} active={isVideoEnabled} />;
          case "screenshare":
            return <FloatingControlBarButton key={type} icon={isScreenSharing ? <MonitorOffIcon /> : <Monitor01Icon />} label={isScreenSharing ? "Stop share" : "Share"} onClick={onToggleScreenShare} active={isScreenSharing} />;
          case "whiteboard":
            return <FloatingControlBarButton key={type} icon={<Edit02Icon />} label="Board" onClick={onToggleWhiteboard} active={isWhiteboardOpen} />;
          case "handraise":
            return <FloatingControlBarButton key={type} icon={<HandIcon />} label={isHandRaised ? "Lower" : "Raise"} onClick={onToggleHandRaise} active={isHandRaised} />;
          case "participants":
            return <FloatingControlBarButton key={type} icon={<UserGroupIcon />} label="People" onClick={onToggleParticipants} active={isParticipantsOpen} />;
          case "chat":
            return <FloatingControlBarButton key={type} icon={<Message01Icon />} label="Chat" onClick={onToggleChat} active={isChatOpen} badge={!isChatOpen ? unreadChatCount : 0} />;
          case "reactions":
          case "thumbsup":
            return <FloatingControlBarButton key={type} icon={<SmileIcon />} label="React" onClick={onOpenReactions} />;
          case "record":
            return <FloatingControlBarButton key={type} icon={<CircleIcon className={isRecording ? "fill-current" : ""} />} label={isRecording ? "Stop" : "Record"} onClick={onToggleRecording} active={isRecording} />;
          case "transcription":
            return <FloatingControlBarButton key={type} icon={<FileTextIcon />} label="Transcript" onClick={onToggleTranscription} active={isTranscriptionEnabled} />;
          case "pip":
            return onTogglePictureInPicture ? <FloatingControlBarButton key={type} icon={<PictureInPictureIcon />} label="Picture in picture" onClick={() => void onTogglePictureInPicture()} active={isPictureInPictureActive} /> : null;
          case "settings":
            return <FloatingControlBarButton key={type} icon={<Settings01Icon />} label="Settings" onClick={onOpenSettings} />;
          case "diagnostics":
            return onOpenDiagnostics ? <FloatingControlBarButton key={type} icon={<InformationCircleIcon />} label="Diagnostics" onClick={onOpenDiagnostics} /> : null;
          case "more":
            return <FloatingControlBarButton key={type} icon={<MoreHorizontalIcon />} label="More" onClick={onOpenMore} />;
          case "info":
            return <FloatingControlBarButton key={type} icon={<InformationCircleIcon />} label="Info" onClick={onOpenInfo} />;
          default:
            return null;
        }
      };

      return (
        <div className="pointer-events-none flex w-full items-end justify-center px-3 pb-5">
          <div className={cn("pointer-events-auto flex max-w-full items-center gap-2 overflow-visible", className)} style={themeVariables as React.CSSProperties} role="toolbar" aria-label="Space controls">
            {buttonsToRender.includes("mic") ? (
              <DevicePopover
                type="mic"
                appearance="floating"
                isActive={!isMuted}
                onToggle={onToggleMute ?? (() => {})}
                devices={effectiveAudioInputDevices}
                selectedDeviceId={selectedAudioInput}
                onDeviceChange={onAudioInputChange ?? (() => {})}
                secondaryDevices={effectiveAudioOutputDevices}
                selectedSecondaryDeviceId={selectedAudioOutput}
                onSecondaryDeviceChange={onAudioOutputChange}
                orientation="up"
                haptic="medium"
              />
            ) : null}
            {buttonsToRender.includes("video") ? (
              <DevicePopover type="video" appearance="floating" isActive={isVideoEnabled} onToggle={onToggleVideo ?? (() => {})} devices={effectiveVideoInputDevices} selectedDeviceId={selectedVideoInput} onDeviceChange={onVideoInputChange ?? (() => {})} orientation="up" haptic="medium" />
            ) : null}
            {buttonsToRender.filter((button) => button !== "mic" && button !== "video" && button !== "leave").map(floatingButton)}
            {showLeave ? <FloatingControlBarButton icon={<CallEnd01Icon />} label="Leave" onClick={onLeft} danger /> : null}
          </div>
        </div>
      );
    }

    return (
      <div className={cn("flex items-center justify-between w-full px-6 py-4", className)} style={themeVariables as React.CSSProperties} role="toolbar" aria-label="Space controls">
        {/* Left: Timer section */}
        <div className="flex items-center rounded-full px-5 py-2.5 bg-[var(--chalk-surface)] border border-[var(--chalk-line)] shadow-md">
          <div className="flex items-center gap-3">
            <div className="w-2.5 h-2.5 rounded-full bg-[var(--chalk-positive)] shadow-[0_0_14px_var(--chalk-positive)]" />
            <span className="text-[14px] font-semibold tracking-wide tabular-nums text-[var(--chalk-text)]">{formatDuration(duration)}</span>
          </div>
        </div>

        {/* Middle: Media controls */}
        <div className="flex items-center gap-3">
          {mediaButtons.map(renderButton)}
          {showLeave && (
            <div className="ml-2">
              <ControlBarButton key="leave" icon={<CallEnd01Icon size={20} />} label="Leave" onClick={onLeft} danger data-tour="controls-leave" />
            </div>
          )}
        </div>

        {/* Right: Interaction controls */}
        <div className="flex items-center gap-4">{interactionButtons.map(renderButton)}</div>
      </div>
    );
  },
);

ControlBar.displayName = "ControlBar";
