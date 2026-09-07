import { useCallback, useEffect, useMemo, useState } from "react";
import type React from "react";

import { useCan, useChat, useMedia, useSelf, useSpaceClient } from "../../bindings/hooks";
import { useEpisodeDuration } from "../../internal/useEpisodeDuration";
import { getParticipantThemeVariables, type ParticipantGradientPreference } from "../../utils/colorGenerator";

export interface MediaDevice {
  deviceId: string;
  label: string;
  kind: MediaDeviceKind;
  groupId?: string;
}

export type ControlBarButtonName = "mic" | "video" | "screenshare" | "record" | "chat" | "participants" | "transcription" | "handraise" | "reactions" | "whiteboard" | "pip" | "settings" | "diagnostics" | "feedback" | "more" | "info" | "thumbsup" | "leave";

export interface ControlBarSurfaceProps {
  position?: "bottom" | "top";
  placement?: "inline" | "floating";
  density?: "comfortable" | "compact";
  showLabels?: boolean;
  buttons?: ControlBarButtonName[];

  isMuted?: boolean;
  microphonePending?: boolean;
  cameraPending?: boolean;
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
  onOpenFeedback?: () => void;
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
  readonly onToggleChat?: () => void;
  readonly onToggleParticipants?: () => void;
  readonly onToggleWhiteboard?: () => void;
  readonly onOpenReactions?: () => void;
  readonly onOpenSettings?: () => void;
  readonly onOpenDiagnostics?: () => void;
  readonly onOpenFeedback?: () => void;
  readonly onOpenMore?: () => void;
  readonly onOpenInfo?: () => void;
  readonly onLeaveRequest?: () => void;
  readonly onLeft?: () => void;
  readonly onCommandError?: (message: string | null) => void;
  readonly participantColorSeed?: string;
  readonly participantGradientPreference?: ParticipantGradientPreference;
  readonly className?: string;
}

export const DEFAULT_CONTROL_BAR_BUTTONS: ControlBarButtonName[] = ["mic", "video", "screenshare", "whiteboard", "handraise", "leave", "participants", "chat", "thumbsup", "pip", "settings"];

export function formatControlBarDuration(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
  }
  return `${minutes}:${String(secs).padStart(2, "0")}`;
}

interface DeviceGroups {
  readonly audioinput: MediaDevice[];
  readonly audiooutput: MediaDevice[];
  readonly videoinput: MediaDevice[];
}

const EMPTY_DETECTED_DEVICES: DeviceGroups = {
  audioinput: [],
  audiooutput: [],
  videoinput: [],
};

function mergeDevices(...deviceGroups: ReadonlyArray<readonly MediaDevice[] | undefined>): MediaDevice[] {
  const devicesById = new Map<string, MediaDevice>();
  for (const deviceGroup of deviceGroups) {
    for (const device of deviceGroup ?? []) {
      const existing = devicesById.get(device.deviceId);
      if (!existing || (!existing.label && device.label)) {
        devicesById.set(device.deviceId, device);
      }
    }
  }
  return [...devicesById.values()];
}

function withSelectedDeviceFallback(devices: readonly MediaDevice[] | undefined, selectedDeviceId: string | undefined, fallbackLabel: string, kind: MediaDevice["kind"]): MediaDevice[] {
  if (devices?.length) return [...devices];
  return selectedDeviceId ? [{ deviceId: selectedDeviceId, label: fallbackLabel, kind }] : [];
}

interface ControlBarSurfaceBehaviorOptions {
  readonly placement: "inline" | "floating";
  readonly density: "comfortable" | "compact";
  readonly buttons?: ControlBarButtonName[];
  readonly audioInputDevices?: readonly MediaDevice[];
  readonly audioOutputDevices?: readonly MediaDevice[];
  readonly videoInputDevices?: readonly MediaDevice[];
  readonly selectedAudioInput?: string;
  readonly selectedAudioOutput?: string;
  readonly selectedVideoInput?: string;
  readonly participantColorSeed?: string;
  readonly participantGradientPreference?: ParticipantGradientPreference;
}

interface ControlBarSurfaceBehavior {
  readonly themeVariables: React.CSSProperties;
  readonly buttonsToRender: readonly ControlBarButtonName[];
  readonly effectiveAudioInputDevices: readonly MediaDevice[];
  readonly effectiveAudioOutputDevices: readonly MediaDevice[];
  readonly effectiveVideoInputDevices: readonly MediaDevice[];
  readonly showLeave: boolean;
  readonly mediaButtons: readonly ControlBarButtonName[];
  readonly interactionButtons: readonly ControlBarButtonName[];
}

export function useControlBarSurfaceBehavior({
  placement,
  density,
  buttons,
  audioInputDevices,
  audioOutputDevices,
  videoInputDevices,
  selectedAudioInput,
  selectedAudioOutput,
  selectedVideoInput,
  participantColorSeed,
  participantGradientPreference,
}: ControlBarSurfaceBehaviorOptions): ControlBarSurfaceBehavior {
  const themeVariables = useMemo(() => getParticipantThemeVariables(participantColorSeed, participantGradientPreference), [participantColorSeed, participantGradientPreference]);
  const [detectedDevices, setDetectedDevices] = useState(EMPTY_DETECTED_DEVICES);
  const buttonsToRender = buttons ?? DEFAULT_CONTROL_BAR_BUTTONS;

  useEffect(() => {
    if (placement !== "floating" || density !== "comfortable" || !navigator.mediaDevices?.enumerateDevices) return;
    let cancelled = false;
    const syncDevices = async () => {
      try {
        const devices = await navigator.mediaDevices.enumerateDevices();
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
  const mediaButtons = buttonsToRender.filter((button) => button === "mic" || button === "video" || button === "screenshare" || button === "record" || button === "whiteboard" || button === "handraise");
  const interactionButtons = buttonsToRender.filter(
    (button) => button === "participants" || button === "chat" || button === "transcription" || button === "thumbsup" || button === "pip" || button === "reactions" || button === "settings" || button === "diagnostics" || button === "feedback" || button === "more" || button === "info",
  );

  return {
    themeVariables,
    buttonsToRender,
    effectiveAudioInputDevices,
    effectiveAudioOutputDevices,
    effectiveVideoInputDevices,
    showLeave,
    mediaButtons,
    interactionButtons,
  };
}

interface ConnectedControlBarBehavior {
  readonly surfaceProps: ControlBarSurfaceProps;
  readonly commandError: string | null;
}

export function useConnectedControlBarBehavior(props: ControlBarProps): ConnectedControlBarBehavior {
  const client = useSpaceClient();
  const self = useSelf();
  const media = useMedia();
  const chat = useChat();
  const canPublishScreen = useCan("publishScreen");
  const canSendReaction = useCan("sendReaction");
  const canRaiseHand = useCan("raiseHand");
  const canDrawWhiteboard = useCan("drawWhiteboard");
  const microphoneEnabled = media.local.microphone.state === "enabled";
  const cameraEnabled = media.local.camera.state === "enabled";
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

  const buttons = (props.buttons ?? DEFAULT_CONTROL_BAR_BUTTONS).filter((button) => {
    if (button === "screenshare") return canPublishScreen;
    if (button === "reactions" || button === "thumbsup") return canSendReaction;
    if (button === "handraise") return canRaiseHand;
    if (button === "whiteboard") return canDrawWhiteboard;
    return true;
  });
  const audioInputDevices: MediaDevice[] = media.devices.microphones.map((device) => ({ ...device, kind: "audioinput" }));
  const audioOutputDevices: MediaDevice[] = media.devices.speakers.map((device) => ({ ...device, kind: "audiooutput" }));
  const videoInputDevices: MediaDevice[] = media.devices.cameras.map((device) => ({ ...device, kind: "videoinput" }));
  const surfaceProps: ControlBarSurfaceProps = {
    ...props,
    buttons,
    duration: episodeDuration,
    isMuted: !microphoneEnabled,
    microphonePending: media.local.microphone.state === "requesting",
    cameraPending: media.local.camera.state === "requesting",
    isVideoEnabled: cameraEnabled,
    isScreenSharing: screenSharing,
    isChatOpen: props.activePanel === "chat",
    isParticipantsOpen: props.activePanel === "participants",
    isHandRaised: self.handRaised,
    unreadChatCount: chat.unreadCount,
    audioInputDevices,
    audioOutputDevices,
    videoInputDevices,
    selectedAudioInput: media.selection.microphone ?? undefined,
    selectedAudioOutput: media.selection.speaker ?? undefined,
    selectedVideoInput: media.selection.camera ?? undefined,
    onToggleMute: () => void run(() => client.media.setMicrophoneEnabled(!microphoneEnabled)),
    onToggleVideo: () => void run(() => client.media.setCameraEnabled(!cameraEnabled)),
    onAudioInputChange: (deviceId) => void run(() => client.media.selectMicrophone(deviceId)),
    onAudioOutputChange: (deviceId) => void run(() => client.media.selectSpeaker(deviceId)),
    onVideoInputChange: (deviceId) => void run(() => client.media.selectCamera(deviceId)),
    onToggleScreenShare: () => void run(() => client.media.setScreenShareEnabled(!screenSharing)),
    onToggleChat: props.onToggleChat,
    onToggleParticipants: props.onToggleParticipants,
    onToggleHandRaise: () => void run(() => (self.handRaised ? client.participants.lowerHand() : client.participants.raiseHand())),
    onToggleWhiteboard: props.onToggleWhiteboard,
    onOpenReactions: props.onOpenReactions,
    onOpenSettings: props.onOpenSettings,
    onOpenDiagnostics: props.onOpenDiagnostics,
    onOpenFeedback: props.onOpenFeedback,
    onOpenMore: props.onOpenMore,
    onOpenInfo: props.onOpenInfo,
    onLeft: leave,
  };

  return { surfaceProps, commandError };
}
