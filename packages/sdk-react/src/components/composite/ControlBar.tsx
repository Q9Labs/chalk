import type { MediaDevice } from "@q9labs/chalk-core";
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
import { ControlButton } from "../atomic";
import { getParticipantThemeVariables, type ParticipantGradientPreference } from "../../utils/colorGenerator";
import { DeviceControlButton } from "./DeviceControlButton";

export type ControlBarButton = "mic" | "video" | "screenshare" | "record" | "chat" | "participants" | "transcription" | "handraise" | "reactions" | "whiteboard" | "pip" | "settings" | "more" | "info" | "thumbsup" | "leave";

export interface ControlBarProps {
  position?: "bottom" | "top";
  variant?: "floating" | "fixed" | "minimal" | "mobile" | "dock";
  showLabels?: boolean;
  buttons?: ControlBarButton[];

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
  meetingDuration?: number;
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
  onOpenMore?: () => void;
  onOpenInfo?: () => void;
  onLeave?: () => void;

  participantColorSeed?: string;
  participantGradientPreference?: ParticipantGradientPreference;
  className?: string;
}

const EMPTY_DETECTED_DEVICES = {
  audioinput: [] as MediaDevice[],
  audiooutput: [] as MediaDevice[],
  videoinput: [] as MediaDevice[],
};

function mergeDevices(...deviceGroups: ReadonlyArray<readonly MediaDevice[] | undefined>) {
  const devicesById = new Map<string, MediaDevice>();

  for (const deviceGroup of deviceGroups) {
    if (!deviceGroup) {
      continue;
    }

    for (const device of deviceGroup) {
      const existingDevice = devicesById.get(device.deviceId);
      if (!existingDevice || (!existingDevice.label && device.label)) {
        devicesById.set(device.deviceId, device);
      }
    }
  }

  return Array.from(devicesById.values());
}

function withSelectedDeviceFallback(devices: readonly MediaDevice[] | undefined, selectedDeviceId: string | undefined, fallbackLabel: string, kind: MediaDevice["kind"]) {
  if (devices && devices.length > 0) {
    return devices;
  }

  if (!selectedDeviceId) {
    return [];
  }

  return [
    {
      deviceId: selectedDeviceId,
      label: fallbackLabel,
      kind,
    },
  ];
}

const formatDuration = (seconds: number) => {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
  }
  return `${minutes}:${String(secs).padStart(2, "0")}`;
};

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
    meetingDuration = 0,
    unreadChatCount = 0,
    audioInputDevices,
    audioOutputDevices,
    videoInputDevices,
    selectedAudioInput,
    selectedAudioOutput,
    selectedVideoInput,
    showLabels = false,
    variant = "floating",
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
    onOpenMore,
    onOpenInfo,
    onLeave,
    participantColorSeed,
    participantGradientPreference,

    className,
  }: ControlBarProps) => {
    const themeVariables = useMemo(() => getParticipantThemeVariables(participantColorSeed, participantGradientPreference), [participantColorSeed, participantGradientPreference]);
    const [detectedDevices, setDetectedDevices] = useState(EMPTY_DETECTED_DEVICES);
    const defaultButtons: ControlBarButton[] = ["mic", "video", "screenshare", "whiteboard", "handraise", "leave", "participants", "chat", "transcription", "thumbsup", "pip", "settings"];

    const buttonsToRender = buttons ?? defaultButtons;
    useEffect(() => {
      if (variant !== "dock") {
        return;
      }

      const mediaDevices = navigator.mediaDevices;
      if (!mediaDevices?.enumerateDevices) {
        return;
      }

      let isCancelled = false;

      const syncDevices = async () => {
        try {
          const devices = (await mediaDevices.enumerateDevices()) as MediaDevice[];
          if (isCancelled) {
            return;
          }

          setDetectedDevices({
            audioinput: devices.filter((device) => device.kind === "audioinput"),
            audiooutput: devices.filter((device) => device.kind === "audiooutput"),
            videoinput: devices.filter((device) => device.kind === "videoinput"),
          });
        } catch {
          if (!isCancelled) {
            setDetectedDevices(EMPTY_DETECTED_DEVICES);
          }
        }
      };

      void syncDevices();
      mediaDevices.addEventListener?.("devicechange", syncDevices);

      return () => {
        isCancelled = true;
        mediaDevices.removeEventListener?.("devicechange", syncDevices);
      };
    }, [variant]);

    const effectiveAudioInputDevices = withSelectedDeviceFallback(mergeDevices(audioInputDevices, detectedDevices.audioinput), selectedAudioInput, "Current microphone", "audioinput");
    const effectiveAudioOutputDevices = withSelectedDeviceFallback(mergeDevices(audioOutputDevices, detectedDevices.audiooutput), selectedAudioOutput, "Current speaker", "audiooutput");
    const effectiveVideoInputDevices = withSelectedDeviceFallback(mergeDevices(videoInputDevices, detectedDevices.videoinput), selectedVideoInput, "Current camera", "videoinput");

    const showLeave = buttonsToRender.includes("leave");
    const mediaButtons = buttonsToRender.filter((b) => b === "mic" || b === "video" || b === "screenshare" || b === "record" || b === "whiteboard" || b === "handraise");
    const interactionButtons = buttonsToRender.filter((b) => b === "participants" || b === "chat" || b === "transcription" || b === "thumbsup" || b === "pip" || b === "reactions" || b === "settings" || b === "more" || b === "info");

    const renderButton = (type: ControlBarButton) => {
      switch (type) {
        case "mic":
          return <ControlButton key="mic" icon={isMuted ? <MicrophoneOff01Icon className="text-[#dc2626]" /> : <Microphone01Icon />} label={isMuted ? "Unmute" : "Mute"} onClick={onToggleMute} active={!isMuted} showLabel={showLabels} data-tour="controls-mic" />;
        case "video":
          return <ControlButton key="video" icon={isVideoEnabled ? <Video01Icon /> : <VideoOffIcon className="text-[#dc2626]" />} label={isVideoEnabled ? "Stop Video" : "Start Video"} onClick={onToggleVideo} active={isVideoEnabled} showLabel={showLabels} data-tour="controls-video" />;
        case "screenshare":
          return (
            <ControlButton
              key="screenshare"
              icon={isScreenSharing ? <MonitorOffIcon /> : <Monitor01Icon />}
              label={isScreenSharing ? "Stop Share" : "Share Screen"}
              onClick={onToggleScreenShare}
              active={isScreenSharing}
              activeClassName="bg-primary text-primary-foreground hover:bg-primary/90"
              showLabel={showLabels}
              data-tour="controls-screenshare"
            />
          );
        case "record":
          return <ControlButton key="record" icon={<CircleIcon className={isRecording ? "fill-current" : ""} />} label={isRecording ? "Stop Recording" : "Record"} onClick={onToggleRecording} active={isRecording} showLabel={showLabels} data-tour="controls-record" />;
        case "chat":
          return (
            <div key="chat" className="relative">
              <ControlButton icon={<Message01Icon />} label="Chat" onClick={onToggleChat} active={isChatOpen} activeClassName="bg-primary text-primary-foreground hover:bg-primary/90" showLabel={showLabels} data-tour="controls-chat" />
              {unreadChatCount > 0 && !isChatOpen && <span className="absolute -top-1 -right-1 flex items-center justify-center min-w-[18px] h-[18px] px-1 text-[10px] font-semibold text-white bg-[#dc2626] rounded-full shadow-sm">{unreadChatCount > 99 ? "99+" : unreadChatCount}</span>}
            </div>
          );
        case "participants":
          return <ControlButton key="participants" icon={<UserGroupIcon />} label="People" onClick={onToggleParticipants} active={isParticipantsOpen} activeClassName="bg-primary text-primary-foreground hover:bg-primary/90" showLabel={showLabels} data-tour="controls-participants" />;
        case "transcription":
          return <ControlButton key="transcription" icon={<FileTextIcon />} label="Transcript" onClick={onToggleTranscription} active={isTranscriptionEnabled} activeClassName="bg-primary text-primary-foreground hover:bg-primary/90" showLabel={showLabels} />;
        case "handraise":
          return <ControlButton key="handraise" icon={<HandIcon />} label={isHandRaised ? "Lower Hand" : "Raise Hand"} onClick={onToggleHandRaise} active={isHandRaised} activeClassName="bg-primary text-primary-foreground hover:bg-primary/90" showLabel={showLabels} />;
        case "reactions":
          return <ControlButton key="reactions" icon={<SmileIcon />} label="Reactions" onClick={onOpenReactions} showLabel={showLabels} />;
        case "whiteboard":
          return <ControlButton key="whiteboard" icon={<Edit02Icon />} label="Whiteboard" onClick={onToggleWhiteboard} active={isWhiteboardOpen} activeClassName="bg-primary text-primary-foreground hover:bg-primary/90" showLabel={showLabels} />;
        case "pip":
          if (!onTogglePictureInPicture) {
            return null;
          }
          return (
            <ControlButton
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
              activeClassName="bg-primary text-primary-foreground hover:bg-primary/90"
              showLabel={showLabels}
            />
          );
        case "settings":
          return <ControlButton key="settings" icon={<Settings01Icon size={20} />} label="Settings" onClick={onOpenSettings} showLabel={showLabels} />;
        case "more":
          return <ControlButton key="more" icon={<MoreHorizontalIcon />} label="More" onClick={onOpenMore} showLabel={showLabels} />;
        case "leave":
          return null; // Handled explicitly in the layout
        case "info":
          return <ControlButton key="info" icon={<InformationCircleIcon size={20} />} label="Info" onClick={onOpenInfo} noBorder />;
        case "thumbsup":
          return <ControlButton key="thumbsup" icon={<ThumbsUpIcon size={20} className="text-[#FFD700]" />} label="Reactions" onClick={onOpenReactions} />;
        default:
          return null;
      }
    };

    // Mobile variant: Dock section layout matching the screenshot
    if (variant === "mobile") {
      return (
        <div
          className={cn("flex flex-nowrap overflow-x-auto scrollbar-none items-center gap-2 w-full px-2 sm:px-4 py-3 bg-[#09090b]", className)}
          style={{
            ...(themeVariables as React.CSSProperties),
            paddingBottom: "max(12px, env(safe-area-inset-bottom))",
          }}
          role="toolbar"
          aria-label="Meeting controls"
        >
          <div className="flex items-center justify-center gap-1.5 min-w-min mx-auto">
            {/* Group 1: Media Controls */}
            <div className="flex items-center shrink-0 gap-1 p-1 bg-[#18181b] rounded-full">
              <button
                type="button"
                onClick={onToggleMute}
                className={cn("flex items-center justify-center w-[44px] h-[44px] sm:w-[46px] sm:h-[46px] rounded-full transition-all active:scale-95", !isMuted ? "text-white" : "text-[#ef4444]")}
                aria-label={isMuted ? "Unmute" : "Mute"}
                aria-pressed={!isMuted}
              >
                {isMuted ? <MicrophoneOff01Icon className="w-5 h-5" /> : <Microphone01Icon className="w-5 h-5" />}
              </button>

              <button
                type="button"
                onClick={onToggleVideo}
                className={cn("flex items-center justify-center w-[44px] h-[44px] sm:w-[46px] sm:h-[46px] rounded-full transition-all active:scale-95", isVideoEnabled ? "text-white" : "text-[#ef4444]")}
                aria-label={isVideoEnabled ? "Stop Video" : "Start Video"}
                aria-pressed={isVideoEnabled}
              >
                {isVideoEnabled ? <Video01Icon className="w-5 h-5" /> : <VideoOffIcon className="w-5 h-5" />}
              </button>
            </div>

            {/* Group 2: Interactions */}
            <div className="flex items-center shrink-0 gap-1 p-1 bg-[#18181b] rounded-full">
              {onToggleScreenShare && (
                <button type="button" onClick={onToggleScreenShare} className={cn("flex items-center justify-center w-[44px] h-[44px] sm:w-[46px] sm:h-[46px] rounded-full transition-all active:scale-95 text-white", isScreenSharing ? "bg-primary text-primary-foreground" : "")} aria-label="Share Screen">
                  {isScreenSharing ? <MonitorOffIcon className="w-5 h-5" /> : <Monitor01Icon className="w-5 h-5" />}
                </button>
              )}
              {onToggleHandRaise && (
                <button type="button" onClick={onToggleHandRaise} className={cn("flex items-center justify-center w-[44px] h-[44px] sm:w-[46px] sm:h-[46px] rounded-full transition-all active:scale-95 text-white", isHandRaised ? "bg-primary text-primary-foreground" : "")} aria-label="Raise Hand">
                  <HandIcon className="w-5 h-5" />
                </button>
              )}
              {onOpenReactions && (
                <button type="button" onClick={onOpenReactions} className={cn("flex items-center justify-center w-[44px] h-[44px] sm:w-[46px] sm:h-[46px] rounded-full transition-all active:scale-95 text-[#FFD700]")} aria-label="Reactions">
                  <ThumbsUpIcon className="w-5 h-5" />
                </button>
              )}
            </div>

            {/* Group 3: More & Leave */}
            <div className="flex items-center shrink-0 gap-1 p-1 bg-[#18181b] rounded-full">
              <button type="button" onClick={onOpenMore} className="flex items-center justify-center w-[44px] h-[44px] sm:w-[46px] sm:h-[46px] rounded-full transition-all active:scale-95 text-white" aria-label="More options">
                <MoreHorizontalIcon className="w-5 h-5" />
              </button>
              <button type="button" onClick={onLeave} className="flex items-center justify-center px-4 h-[44px] sm:h-[46px] rounded-full bg-[#ef4444] hover:bg-[#dc2626] transition-all active:scale-95 text-white shadow-lg" aria-label="Leave meeting">
                <CallEnd01Icon className="w-5 h-5" />
              </button>
            </div>
          </div>
        </div>
      );
    }

    if (variant === "dock") {
      return (
        <div className="relative flex items-end justify-center w-full pointer-events-none">
          {/* Left: Timer section - Absolute positioned */}
          <div className="absolute left-6 bottom-3 flex items-center rounded-full px-3 py-1.5 bg-white/80 dark:bg-zinc-950/80 backdrop-blur-xl border border-black/10 dark:border-white/10 shadow-lg pointer-events-auto">
            <div className="flex items-center gap-2">
              <div className="w-1.5 h-1.5 rounded-full bg-red-500 animate-pulse" />
              <span className="text-xs font-medium tracking-wide tabular-nums text-zinc-900 dark:text-white/90">{formatDuration(meetingDuration)}</span>
            </div>
          </div>

          {/* Center: Main Dock */}
          <div
            className={cn(
              "flex items-center justify-between gap-4 px-6 pt-2 pb-2 rounded-t-[2.5rem] rounded-b-none backdrop-blur-xl border border-black/10 dark:border-white/10 shadow-[0_-10px_40px_-15px_rgba(0,0,0,0.2)] dark:shadow-[0_-10px_40px_-15px_rgba(0,0,0,0.5)] pointer-events-auto",
              "bg-white/90 dark:bg-zinc-950/90",
              className,
            )}
            style={themeVariables as React.CSSProperties}
            role="toolbar"
            aria-label="Meeting controls"
          >
            {/* Middle: Media controls */}
            <div className="flex items-center gap-1.5">
              <DeviceControlButton
                type="mic"
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

              <DeviceControlButton type="video" isActive={isVideoEnabled} onToggle={onToggleVideo ?? (() => {})} devices={effectiveVideoInputDevices} selectedDeviceId={selectedVideoInput} onDeviceChange={onVideoInputChange ?? (() => {})} orientation="up" haptic="medium" />

              <div className="flex items-center gap-1 px-2 py-1.5 bg-black/5 dark:bg-white/5 rounded-full border border-black/5 dark:border-white/5">
                {renderButton("screenshare")}
                {renderButton("whiteboard")}
                {renderButton("handraise")}
              </div>

              <div className="ml-1">
                <ControlButton key="leave" icon={<CallEnd01Icon size={20} />} label="Leave" onClick={onLeave} danger className="h-10 w-auto px-5 rounded-full hover:scale-105 transition-transform shadow-lg" data-tour="controls-leave" />
              </div>
            </div>

            {/* Divider */}
            <div className="w-px h-8 bg-black/10 dark:bg-white/10" />

            {/* Right: Interaction controls */}
            <div className="flex items-center gap-1 px-2 py-1.5 bg-black/5 dark:bg-white/5 rounded-full border border-black/5 dark:border-white/5">
              {renderButton("participants")}
              {renderButton("chat")}
              {renderButton("transcription")}
              {renderButton("thumbsup")}
              {renderButton("settings")}
            </div>
          </div>
        </div>
      );
    }

    return (
      <div className={cn("flex items-center justify-between w-full px-6 py-4", className)} style={themeVariables as React.CSSProperties} role="toolbar" aria-label="Meeting controls">
        {/* Left: Timer section */}
        <div
          className="flex items-center rounded-full px-5 py-2.5 bg-card border border-border shadow-md"
        >
          <div className="flex items-center gap-3">
            <div
              className="w-2.5 h-2.5 rounded-full bg-[#22c55e] shadow-[0_0_14px_rgba(34,197,94,0.4)]"
            />
            <span className="text-[14px] font-semibold tracking-wide tabular-nums text-foreground">
              {formatDuration(meetingDuration)}
            </span>
          </div>
        </div>

        {/* Middle: Media controls */}
        <div className="flex items-center gap-3">
          {mediaButtons.map(renderButton)}
          {showLeave && (
            <div className="ml-2">
              <ControlButton key="leave" icon={<CallEnd01Icon size={20} />} label="Leave" onClick={onLeave} danger data-tour="controls-leave" />
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
