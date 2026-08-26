import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Tooltip } from "@q9labsai/chalk-ui";
import { useCan, useChat, useMedia, useSelf, useSpaceClient } from "../../bindings/hooks";
import { useEpisodeDuration } from "../../internal/useEpisodeDuration";
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
import { CommandErrorAlert } from "../composite/CommandErrorAlert";
import { ChalkBadge, ChalkButton, ChalkControlGroup, ChalkIconButton, ChalkPanel } from "../chalk-ui";
import { useSkin } from "../skin-context";
import { ClassicControlBar } from "./ClassicControlBar";

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

interface ControlBarSurfaceProps {
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

export interface ControlBarProps {
  readonly position?: "bottom" | "top";
  readonly placement?: "inline" | "floating";
  readonly density?: "comfortable" | "compact";
  /** A shared Episode clock supplied by the owning Space surface. */
  readonly duration?: number;
  readonly showLabels?: boolean;
  readonly buttons?: ControlBarButtonName[];
  readonly activePanel?: "chat" | "participants" | null;
  readonly isWhiteboardOpen?: boolean;
  readonly onToggleChat?: () => void;
  readonly onToggleParticipants?: () => void;
  readonly onToggleWhiteboard?: () => void;
  readonly onOpenReactions?: () => void;
  readonly onOpenSettings?: () => void;
  readonly onOpenDiagnostics?: () => void;
  readonly onOpenMore?: () => void;
  readonly onOpenInfo?: () => void;
  readonly onLeaveRequest?: () => void;
  readonly onLeft?: () => void;
  readonly onCommandError?: (message: string | null) => void;
  readonly participantColorSeed?: string;
  readonly participantGradientPreference?: ParticipantGradientPreference;
  readonly className?: string;
}

const DEFAULT_BUTTONS: ControlBarButtonName[] = ["mic", "video", "screenshare", "whiteboard", "handraise", "leave", "participants", "chat", "thumbsup", "pip", "settings"];

const formatDuration = (seconds: number) => {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
  }
  return `${minutes}:${String(secs).padStart(2, "0")}`;
};

function FloatingControlBarButton({ icon, label, onClick, active = false, danger = false, badge, seed }: { readonly icon: React.ReactNode; readonly label: string; readonly onClick?: () => void; readonly active?: boolean; readonly danger?: boolean; readonly badge?: number; readonly seed: string }) {
  return (
    <Tooltip content={label} position="top">
      <ChalkIconButton
        onClick={onClick}
        aria-label={label}
        aria-pressed={active}
        seed={seed}
        size="lg"
        tone={danger ? "danger" : active ? "accent" : "neutral"}
        className={cn("h-[52px] w-[52px] shrink-0 text-[var(--chalk-app-text)] transition hover:-translate-y-0.5", active && "ring-2 ring-[var(--chalk-app-control-active-line)] ring-offset-2 ring-offset-[var(--chalk-app-canvas)]", danger && "ml-2 !text-[var(--chalk-app-control-active-text)]")}
      >
        {icon}
        {badge && badge > 0 ? <ChalkBadge className="absolute top-1 right-1 min-h-4 min-w-4 px-1 text-[10px] !text-[var(--chalk-app-control-active-text)]" count={badge} max={99} aria-label={`${badge} unread messages`} seed={`${seed}-badge`} tone="danger" /> : null}
      </ChalkIconButton>
    </Tooltip>
  );
}

const ControlBarSurface = React.memo(
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
  }: ControlBarSurfaceProps) => {
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
          return <ControlBarButton key="mic" icon={isMuted ? <MicrophoneOff01Icon className="text-[var(--chalk-app-danger)]" /> : <Microphone01Icon />} label={isMuted ? "Unmute" : "Mute"} onClick={onToggleMute} active={!isMuted} seed="control-mic" showLabel={showLabels} data-tour="controls-mic" />;
        case "video":
          return (
            <ControlBarButton
              key="video"
              icon={isVideoEnabled ? <Video01Icon /> : <VideoOffIcon className="text-[var(--chalk-app-danger)]" />}
              label={isVideoEnabled ? "Stop Video" : "Start Video"}
              onClick={onToggleVideo}
              active={isVideoEnabled}
              seed="control-video"
              showLabel={showLabels}
              data-tour="controls-video"
            />
          );
        case "screenshare":
          return (
            <ControlBarButton
              key="screenshare"
              icon={isScreenSharing ? <MonitorOffIcon /> : <Monitor01Icon />}
              label={isScreenSharing ? "Stop Share" : "Share Screen"}
              onClick={onToggleScreenShare}
              active={isScreenSharing}
              seed="control-screenshare"
              showLabel={showLabels}
              data-tour="controls-screenshare"
            />
          );
        case "record":
          if (!onToggleRecording) return null;
          return <ControlBarButton key="record" icon={<CircleIcon className={isRecording ? "fill-current" : ""} />} label={isRecording ? "Stop Recording" : "Record"} onClick={onToggleRecording} active={isRecording} seed="control-record" showLabel={showLabels} data-tour="controls-record" />;
        case "chat":
          if (!onToggleChat) return null;
          return (
            <div key="chat" className="relative">
              <ControlBarButton icon={<Message01Icon />} label="Chat" onClick={onToggleChat} active={isChatOpen} seed="control-chat" showLabel={showLabels} data-tour="controls-chat" />
              {unreadChatCount > 0 && !isChatOpen ? (
                <ChalkBadge className="absolute -top-1 -right-1 min-h-4 min-w-4 px-1 text-[10px] !text-[var(--chalk-app-control-active-text)]" count={unreadChatCount} max={99} aria-label={`${unreadChatCount} unread messages`} seed="control-chat-badge" tone="danger" />
              ) : null}
            </div>
          );
        case "participants":
          if (!onToggleParticipants) return null;
          return <ControlBarButton key="participants" icon={<UserGroupIcon />} label="Participants" onClick={onToggleParticipants} active={isParticipantsOpen} seed="control-participants" showLabel={showLabels} data-tour="controls-participants" />;
        case "transcription":
          if (!onToggleTranscription) return null;
          return <ControlBarButton key="transcription" icon={<FileTextIcon />} label="Transcript" onClick={onToggleTranscription} active={isTranscriptionEnabled} seed="control-transcription" showLabel={showLabels} />;
        case "handraise":
          if (!onToggleHandRaise) return null;
          return <ControlBarButton key="handraise" icon={<HandIcon />} label={isHandRaised ? "Lower Hand" : "Raise Hand"} onClick={onToggleHandRaise} active={isHandRaised} seed="control-handraise" showLabel={showLabels} />;
        case "reactions":
          if (!onOpenReactions) return null;
          return <ControlBarButton key="reactions" icon={<SmileIcon />} label="Reactions" onClick={onOpenReactions} seed="control-reactions" showLabel={showLabels} />;
        case "whiteboard":
          if (!onToggleWhiteboard) return null;
          return <ControlBarButton key="whiteboard" icon={<Edit02Icon />} label="Whiteboard" onClick={onToggleWhiteboard} active={isWhiteboardOpen} seed="control-whiteboard" showLabel={showLabels} />;
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
              seed="control-pip"
              showLabel={showLabels}
            />
          );
        case "settings":
          if (!onOpenSettings) return null;
          return <ControlBarButton key="settings" icon={<Settings01Icon size={20} />} label="Settings" onClick={onOpenSettings} seed="control-settings" showLabel={showLabels} />;
        case "diagnostics":
          if (!onOpenDiagnostics) {
            return null;
          }
          return <ControlBarButton key="diagnostics" icon={<InformationCircleIcon size={20} />} label="Diagnostics" onClick={onOpenDiagnostics} seed="control-diagnostics" showLabel={showLabels} />;
        case "more":
          if (!onOpenMore) return null;
          return <ControlBarButton key="more" icon={<MoreHorizontalIcon />} label="More" onClick={onOpenMore} seed="control-more" showLabel={showLabels} />;
        case "leave":
          return null; // Handled explicitly in the layout
        case "info":
          if (!onOpenInfo) return null;
          return <ControlBarButton key="info" icon={<InformationCircleIcon size={20} />} label="Info" onClick={onOpenInfo} noBorder seed="control-info" />;
        case "thumbsup":
          if (!onOpenReactions) return null;
          return <ControlBarButton key="thumbsup" icon={<ThumbsUpIcon size={20} className="text-[var(--chalk-app-control-active-text)]" />} label="Reactions" onClick={onOpenReactions} seed="control-thumbsup" />;
        default:
          return null;
      }
    };

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
          <ChalkControlGroup className="mx-auto min-w-min items-center justify-center gap-1.5">
            <ChalkPanel className="order-1 shrink-0 rounded-none p-1" seed="control-compact-media" tone="accent">
              <ChalkControlGroup aria-label="Media controls" className="gap-1">
                <ChalkIconButton aria-label={isMuted ? "Unmute" : "Mute"} aria-pressed={!isMuted} className={!isMuted ? "!text-[var(--chalk-app-control-active-text)]" : "!text-[var(--chalk-app-danger)]"} onClick={onToggleMute} seed="control-compact-mic" size="lg" tone="accent">
                  {isMuted ? <MicrophoneOff01Icon className="h-5 w-5" /> : <Microphone01Icon className="h-5 w-5" />}
                </ChalkIconButton>
                <ChalkIconButton
                  aria-label={isVideoEnabled ? "Stop Video" : "Start Video"}
                  aria-pressed={isVideoEnabled}
                  className={isVideoEnabled ? "!text-[var(--chalk-app-control-active-text)]" : "!text-[var(--chalk-app-danger)]"}
                  onClick={onToggleVideo}
                  seed="control-compact-video"
                  size="lg"
                  tone="accent"
                >
                  {isVideoEnabled ? <Video01Icon className="h-5 w-5" /> : <VideoOffIcon className="h-5 w-5" />}
                </ChalkIconButton>
              </ChalkControlGroup>
            </ChalkPanel>

            <ChalkPanel className="order-3 shrink-0 rounded-none p-1" seed="control-compact-interactions">
              <ChalkControlGroup aria-label="Interaction controls" className="gap-1">
                {buttonsToRender.includes("handraise") && onToggleHandRaise ? (
                  <Tooltip content={isHandRaised ? "Lower hand" : "Raise hand"} position="top">
                    <ChalkIconButton
                      aria-label={isHandRaised ? "Lower hand" : "Raise hand"}
                      aria-pressed={isHandRaised}
                      className={isHandRaised ? "ring-2 ring-[var(--chalk-app-control-active-line)] ring-inset" : undefined}
                      onClick={onToggleHandRaise}
                      seed="control-compact-handraise"
                      size="lg"
                      tone={isHandRaised ? "accent" : "neutral"}
                    >
                      <HandIcon className="h-5 w-5" />
                    </ChalkIconButton>
                  </Tooltip>
                ) : null}
                {buttonsToRender.includes("reactions") && onOpenReactions ? (
                  <Tooltip content="Reactions" position="top">
                    <ChalkIconButton aria-label="Reactions" onClick={onOpenReactions} seed="control-compact-reactions" size="lg" tone="accent">
                      <ThumbsUpIcon className="h-5 w-5" />
                    </ChalkIconButton>
                  </Tooltip>
                ) : null}
                {buttonsToRender.includes("whiteboard") && onToggleWhiteboard ? (
                  <Tooltip content="Board" position="top">
                    <ChalkIconButton
                      aria-label="Whiteboard"
                      aria-pressed={isWhiteboardOpen}
                      className={isWhiteboardOpen ? "ring-2 ring-[var(--chalk-app-control-active-line)] ring-inset" : undefined}
                      onClick={onToggleWhiteboard}
                      seed="control-compact-whiteboard"
                      size="lg"
                      tone={isWhiteboardOpen ? "accent" : "neutral"}
                    >
                      <Edit02Icon className="h-5 w-5" />
                    </ChalkIconButton>
                  </Tooltip>
                ) : null}
                {buttonsToRender.includes("participants") && onToggleParticipants ? (
                  <Tooltip content="Participants" position="top">
                    <ChalkIconButton
                      aria-label="Participants"
                      aria-pressed={isParticipantsOpen}
                      className={isParticipantsOpen ? "ring-2 ring-[var(--chalk-app-control-active-line)] ring-inset" : undefined}
                      onClick={onToggleParticipants}
                      seed="control-compact-participants"
                      size="lg"
                      tone={isParticipantsOpen ? "accent" : "neutral"}
                    >
                      <UserGroupIcon className="h-5 w-5" />
                    </ChalkIconButton>
                  </Tooltip>
                ) : null}
                {buttonsToRender.includes("chat") && onToggleChat ? (
                  <div className="relative">
                    <Tooltip content="Chat" position="top">
                      <ChalkIconButton aria-label="Chat" aria-pressed={isChatOpen} className={isChatOpen ? "ring-2 ring-[var(--chalk-app-control-active-line)] ring-inset" : undefined} onClick={onToggleChat} seed="control-compact-chat" size="lg" tone={isChatOpen ? "accent" : "neutral"}>
                        <Message01Icon className="h-5 w-5" />
                      </ChalkIconButton>
                    </Tooltip>
                    {unreadChatCount > 0 && !isChatOpen ? (
                      <ChalkBadge className="absolute -top-1 -right-1 min-h-4 min-w-4 px-1 text-[10px] !text-[var(--chalk-app-control-active-text)]" count={unreadChatCount} max={99} aria-label={`${unreadChatCount} unread messages`} seed="control-compact-chat-badge" tone="danger" />
                    ) : null}
                  </div>
                ) : null}
              </ChalkControlGroup>
            </ChalkPanel>

            <ChalkPanel className="order-2 shrink-0 rounded-none p-1" seed="control-compact-more-leave">
              <ChalkControlGroup aria-label="More and leave controls" className="gap-1">
                {buttonsToRender.includes("more") && onOpenMore ? (
                  <Tooltip content="More options" position="top">
                    <ChalkIconButton aria-label="More options" onClick={onOpenMore} seed="control-compact-more" size="lg">
                      <MoreHorizontalIcon className="h-5 w-5" />
                    </ChalkIconButton>
                  </Tooltip>
                ) : null}
                <Tooltip content="Leave Space" position="top">
                  <ChalkButton aria-label="Leave space" className="h-12 w-12 min-w-12 px-0 !text-[var(--chalk-app-control-active-text)]" onClick={onLeft} seed="control-compact-leave" tone="danger" variant="solid">
                    <CallEnd01Icon className="h-5 w-5" />
                  </ChalkButton>
                </Tooltip>
              </ChalkControlGroup>
            </ChalkPanel>
          </ChalkControlGroup>
        </div>
      );
    }

    if (placement === "floating" && density === "comfortable") {
      const floatingButton = (type: ControlBarButtonName): React.ReactNode => {
        switch (type) {
          case "mic":
            return <FloatingControlBarButton key={type} icon={isMuted ? <MicrophoneOff01Icon /> : <Microphone01Icon />} label={isMuted ? "Unmute" : "Mute"} onClick={onToggleMute} active={!isMuted} seed="control-floating-mic" />;
          case "video":
            return <FloatingControlBarButton key={type} icon={isVideoEnabled ? <Video01Icon /> : <VideoOffIcon />} label="Camera" onClick={onToggleVideo} active={isVideoEnabled} seed="control-floating-video" />;
          case "screenshare":
            return <FloatingControlBarButton key={type} icon={isScreenSharing ? <MonitorOffIcon /> : <Monitor01Icon />} label={isScreenSharing ? "Stop share" : "Share"} onClick={onToggleScreenShare} active={isScreenSharing} seed="control-floating-screenshare" />;
          case "whiteboard":
            if (!onToggleWhiteboard) return null;
            return <FloatingControlBarButton key={type} icon={<Edit02Icon />} label="Board" onClick={onToggleWhiteboard} active={isWhiteboardOpen} seed="control-floating-whiteboard" />;
          case "handraise":
            if (!onToggleHandRaise) return null;
            return <FloatingControlBarButton key={type} icon={<HandIcon />} label={isHandRaised ? "Lower" : "Raise"} onClick={onToggleHandRaise} active={isHandRaised} seed="control-floating-handraise" />;
          case "participants":
            if (!onToggleParticipants) return null;
            return <FloatingControlBarButton key={type} icon={<UserGroupIcon />} label="Participants" onClick={onToggleParticipants} active={isParticipantsOpen} seed="control-floating-participants" />;
          case "chat":
            if (!onToggleChat) return null;
            return <FloatingControlBarButton key={type} icon={<Message01Icon />} label="Chat" onClick={onToggleChat} active={isChatOpen} badge={!isChatOpen ? unreadChatCount : 0} seed="control-floating-chat" />;
          case "reactions":
          case "thumbsup":
            if (!onOpenReactions) return null;
            return <FloatingControlBarButton key={type} icon={<SmileIcon />} label="React" onClick={onOpenReactions} seed="control-floating-reactions" />;
          case "record":
            if (!onToggleRecording) return null;
            return <FloatingControlBarButton key={type} icon={<CircleIcon className={isRecording ? "fill-current" : ""} />} label={isRecording ? "Stop" : "Record"} onClick={onToggleRecording} active={isRecording} seed="control-floating-record" />;
          case "transcription":
            if (!onToggleTranscription) return null;
            return <FloatingControlBarButton key={type} icon={<FileTextIcon />} label="Transcript" onClick={onToggleTranscription} active={isTranscriptionEnabled} seed="control-floating-transcription" />;
          case "pip":
            return onTogglePictureInPicture ? <FloatingControlBarButton key={type} icon={<PictureInPictureIcon />} label="Picture in picture" onClick={() => void onTogglePictureInPicture()} active={isPictureInPictureActive} seed="control-floating-pip" /> : null;
          case "settings":
            if (!onOpenSettings) return null;
            return <FloatingControlBarButton key={type} icon={<Settings01Icon />} label="Settings" onClick={onOpenSettings} seed="control-floating-settings" />;
          case "diagnostics":
            return onOpenDiagnostics ? <FloatingControlBarButton key={type} icon={<InformationCircleIcon />} label="Diagnostics" onClick={onOpenDiagnostics} seed="control-floating-diagnostics" /> : null;
          case "more":
            if (!onOpenMore) return null;
            return <FloatingControlBarButton key={type} icon={<MoreHorizontalIcon />} label="More" onClick={onOpenMore} seed="control-floating-more" />;
          case "info":
            if (!onOpenInfo) return null;
            return <FloatingControlBarButton key={type} icon={<InformationCircleIcon />} label="Info" onClick={onOpenInfo} seed="control-floating-info" />;
          default:
            return null;
        }
      };

      return (
        <div className="pointer-events-none flex w-full items-end justify-center px-3 pb-5">
          <ChalkPanel className={cn("group pointer-events-auto max-w-full rounded-none p-2", className)} role="toolbar" aria-label="Space controls" seed="control-floating-shell" style={themeVariables as React.CSSProperties} filled={false}>
            <ChalkControlGroup className="max-w-full gap-2 overflow-visible">
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
              <div className="pointer-events-none -ml-2 grid min-w-0 grid-cols-[0fr] -translate-x-1.5 opacity-0 transition-[grid-template-columns,margin,opacity,transform] duration-[260ms] ease-[cubic-bezier(0.22,1,0.36,1)] will-change-[grid-template-columns,opacity,transform] group-hover:pointer-events-auto group-hover:ml-0 group-hover:grid-cols-[1fr] group-hover:translate-x-0 group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:ml-0 group-focus-within:grid-cols-[1fr] group-focus-within:translate-x-0 group-focus-within:opacity-100 motion-reduce:transition-none">
                <div className="-my-2 flex min-w-0 items-center gap-2 overflow-hidden py-2">{buttonsToRender.filter((button) => button !== "mic" && button !== "video" && button !== "leave").map(floatingButton)}</div>
              </div>
              {showLeave ? <FloatingControlBarButton icon={<CallEnd01Icon />} label="Leave" onClick={onLeft} danger seed="control-floating-leave" /> : null}
            </ChalkControlGroup>
          </ChalkPanel>
        </div>
      );
    }

    return (
      <div className={cn("flex items-center justify-between w-full px-6 py-4", className)} style={themeVariables as React.CSSProperties} role="toolbar" aria-label="Space controls">
        <ChalkPanel className="rounded-none p-2" seed="control-inline-timer">
          <ChalkControlGroup aria-label="Episode duration" className="gap-3">
            <ChalkBadge dot aria-label="Live" seed="control-inline-live" tone="success" />
            <span className="text-[var(--chalk-app-text)] text-[14px] font-semibold tracking-wide tabular-nums">{formatDuration(duration)}</span>
          </ChalkControlGroup>
        </ChalkPanel>

        <ChalkControlGroup aria-label="Media controls" className="gap-3">
          {mediaButtons.map(renderButton)}
          {showLeave ? <ControlBarButton key="leave" icon={<CallEnd01Icon size={20} />} label="Leave" onClick={onLeft} danger seed="control-leave" data-tour="controls-leave" /> : null}
        </ChalkControlGroup>

        <ChalkControlGroup aria-label="Interaction controls" className="gap-4">
          {interactionButtons.map(renderButton)}
        </ChalkControlGroup>
      </div>
    );
  },
);

export function ControlBar(props: ControlBarProps): React.JSX.Element {
  const skin = useSkin();
  return skin === "classic" ? <ClassicControlBar {...props} /> : <ChalkControlBar {...props} />;
}

ControlBar.displayName = "ControlBar";

function ChalkControlBar(props: ControlBarProps): React.JSX.Element {
  const client = useSpaceClient();
  const self = useSelf();
  const media = useMedia();
  const chat = useChat();
  const canPublishScreen = useCan("publishScreen");
  const canSendReaction = useCan("sendReaction");
  const canRaiseHand = useCan("raiseHand");
  const canDrawWhiteboard = useCan("drawWhiteboard");
  const microphoneEnabled = media.local.microphone.state === "enabled" || media.local.microphone.state === "requesting";
  const cameraEnabled = media.local.camera.state === "enabled" || media.local.camera.state === "requesting";
  const screenSharing = media.local.screen.state === "enabled" || media.local.screen.state === "requesting";
  const measuredEpisodeDuration = useEpisodeDuration();
  const episodeDuration = props.duration ?? measuredEpisodeDuration;
  const [commandError, setCommandError] = useState<string | null>(null);

  const run = useCallback(
    async (command: () => Promise<unknown>) => {
      try {
        await command();
        setCommandError(null);
        props.onCommandError?.(null);
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : "This command could not be completed.";
        if (!props.onCommandError) setCommandError(message);
        props.onCommandError?.(message);
      }
    },
    [props.onCommandError],
  );
  const leave = useCallback(() => {
    if (props.onLeaveRequest) {
      props.onLeaveRequest();
      return;
    }
    void run(async () => {
      await client.leave();
      props.onLeft?.();
    });
  }, [client, props.onLeaveRequest, props.onLeft, run]);
  const buttons = (props.buttons ?? DEFAULT_BUTTONS).filter((button) => {
    if (button === "screenshare") return canPublishScreen;
    if (button === "reactions" || button === "thumbsup") return canSendReaction;
    if (button === "handraise") return canRaiseHand;
    if (button === "whiteboard") return canDrawWhiteboard;
    return true;
  });
  const audioInputDevices = media.devices.microphones.map((device) => ({ ...device, kind: "audioinput" as const }));
  const audioOutputDevices = media.devices.speakers.map((device) => ({ ...device, kind: "audiooutput" as const }));
  const videoInputDevices = media.devices.cameras.map((device) => ({ ...device, kind: "videoinput" as const }));

  return (
    <>
      <ControlBarSurface
        {...props}
        buttons={buttons}
        duration={episodeDuration}
        isMuted={!microphoneEnabled}
        isVideoEnabled={cameraEnabled}
        isScreenSharing={screenSharing}
        isChatOpen={props.activePanel === "chat"}
        isParticipantsOpen={props.activePanel === "participants"}
        isHandRaised={self.handRaised}
        unreadChatCount={chat.unreadCount}
        audioInputDevices={audioInputDevices}
        audioOutputDevices={audioOutputDevices}
        videoInputDevices={videoInputDevices}
        selectedAudioInput={media.selection.microphone ?? undefined}
        selectedAudioOutput={media.selection.speaker ?? undefined}
        selectedVideoInput={media.selection.camera ?? undefined}
        onToggleMute={() => void run(() => client.media.setMicrophoneEnabled(!microphoneEnabled))}
        onToggleVideo={() => void run(() => client.media.setCameraEnabled(!cameraEnabled))}
        onAudioInputChange={(deviceId) => void run(() => client.media.selectMicrophone(deviceId))}
        onAudioOutputChange={(deviceId) => void run(() => client.media.selectSpeaker(deviceId))}
        onVideoInputChange={(deviceId) => void run(() => client.media.selectCamera(deviceId))}
        onToggleScreenShare={() => void run(() => client.media.setScreenShareEnabled(!screenSharing))}
        onToggleChat={props.onToggleChat}
        onToggleParticipants={props.onToggleParticipants}
        onToggleHandRaise={() => void run(() => (self.handRaised ? client.participants.lowerHand() : client.participants.raiseHand()))}
        onToggleWhiteboard={props.onToggleWhiteboard}
        onOpenReactions={props.onOpenReactions}
        onOpenSettings={props.onOpenSettings}
        onOpenDiagnostics={props.onOpenDiagnostics}
        onOpenMore={props.onOpenMore}
        onOpenInfo={props.onOpenInfo}
        onLeft={leave}
      />
      {!props.onCommandError ? <CommandErrorAlert message={commandError ?? undefined} /> : null}
    </>
  );
}

ChalkControlBar.displayName = "ChalkControlBar";
