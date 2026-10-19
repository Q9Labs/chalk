import { useCallback, useEffect, useMemo, useState } from "react";
import type React from "react";

import { commandFailure } from "./command-failure";
import { useMirrorSetting } from "../../internal/useMirrorSetting";
import type { ClientFailure, MediaSource, ScreenShareOptions } from "@q9labsai/chalk-client";
import { useCan, useChat, useMedia, useParticipants, useRecording, useSelf, useSpaceClient } from "../../bindings/hooks";
import { getParticipantThemeVariables, type ParticipantGradientPreference } from "../../utils/colorGenerator";

export interface MediaDevice {
  deviceId: string;
  label: string;
  kind: MediaDeviceKind;
  groupId?: string;
}

export type ControlBarButtonName = "mic" | "video" | "screenshare" | "record" | "chat" | "participants" | "handraise" | "reactions" | "whiteboard" | "leave";

export interface ControlBarSurfaceProps {
  shareUrl?: string;
  callLinkOpen?: boolean;
  onCallLinkToggle?: () => void;
  layout?: "focus" | "grid";
  onLayoutChange?: (layout: "focus" | "grid") => void;
  density?: "comfortable" | "compact";
  buttons?: ControlBarButtonName[];

  microphoneTrack?: MediaStreamTrack | null;
  cameraTrack?: MediaStreamTrack | null;
  microphoneWarning?: boolean;
  cameraWarning?: boolean;
  speakingWhileMuted?: boolean;
  noiseSuppression?: boolean;
  onNoiseSuppressionChange?: (enabled: boolean) => void;
  mirrored?: boolean;
  onMirrorChange?: (mirrored: boolean) => void;
  onTestSpeaker?: () => void;
  onStartScreenShare?: (options: ScreenShareOptions) => void;
  onCopyError?: () => void;
  onFullscreenError?: () => void;
  knockCount?: number;
  isMuted?: boolean;
  microphonePending?: boolean;
  cameraPending?: boolean;
  isVideoEnabled?: boolean;
  isScreenSharing?: boolean;
  isRecording?: boolean;
  isRecordingPending?: boolean;
  isChatOpen?: boolean;
  isParticipantsOpen?: boolean;
  isHandRaised?: boolean;
  isWhiteboardOpen?: boolean;
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
  onToggleHandRaise?: () => void;
  onToggleWhiteboard?: () => void;
  onOpenReactions?: () => void;
  onLeft?: () => void;
  onEndForEveryone?: () => void;

  participantColorSeed?: string;
  participantGradientPreference?: ParticipantGradientPreference;
  expanded?: boolean;
  detectDevices?: boolean;
  /** Render the requested controls as inert display state without commands. */
  displayOnly?: boolean;
  className?: string;
}

export interface ControlBarProps {
  /** Local self-view only. Omit to use the persisted mirror preference. */
  readonly mirrored?: boolean;
  readonly onMirrorChange?: (mirrored: boolean) => void;
  readonly shareUrl?: string;
  readonly callLinkOpen?: boolean;
  readonly onCallLinkToggle?: () => void;
  readonly layout?: "focus" | "grid";
  readonly onLayoutChange?: (layout: "focus" | "grid") => void;
  readonly density?: "comfortable" | "compact";
  readonly buttons?: ControlBarButtonName[];
  readonly activePanel?: "chat" | "participants" | null;
  readonly onToggleChat?: () => void;
  readonly onToggleParticipants?: () => void;
  readonly onToggleWhiteboard?: () => void;
  readonly onOpenReactions?: () => void;
  readonly onLeaveRequest?: () => void;
  /** Set for hosts: the leave button opens a menu with Leave call and End call for everyone. */
  readonly onEndForEveryone?: () => void;
  readonly onLeft?: () => void;
  readonly onCommandError?: (failure: ClientFailure | null, source?: MediaSource) => void;
  readonly participantColorSeed?: string;
  readonly participantGradientPreference?: ParticipantGradientPreference;
  readonly className?: string;
}

export const DEFAULT_CONTROL_BAR_BUTTONS: ControlBarButtonName[] = ["mic", "video", "screenshare", "record", "whiteboard", "handraise", "leave", "participants", "chat", "reactions"];

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
  readonly detectDevices?: boolean;
}

interface ControlBarSurfaceBehavior {
  readonly themeVariables: React.CSSProperties;
  readonly buttonsToRender: readonly ControlBarButtonName[];
  readonly effectiveAudioInputDevices: readonly MediaDevice[];
  readonly effectiveAudioOutputDevices: readonly MediaDevice[];
  readonly effectiveVideoInputDevices: readonly MediaDevice[];
  readonly showLeave: boolean;
}

export function useControlBarSurfaceBehavior({
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
  detectDevices = true,
}: ControlBarSurfaceBehaviorOptions): ControlBarSurfaceBehavior {
  const themeVariables = useMemo(() => getParticipantThemeVariables(participantColorSeed, participantGradientPreference), [participantColorSeed, participantGradientPreference]);
  const [detectedDevices, setDetectedDevices] = useState(EMPTY_DETECTED_DEVICES);
  const buttonsToRender = buttons ?? DEFAULT_CONTROL_BAR_BUTTONS;

  useEffect(() => {
    if (!detectDevices || density !== "comfortable" || !navigator.mediaDevices?.enumerateDevices) return;
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
  }, [density, detectDevices]);

  const effectiveAudioInputDevices = withSelectedDeviceFallback(mergeDevices(audioInputDevices, detectedDevices.audioinput), selectedAudioInput, "Current microphone", "audioinput");
  const effectiveAudioOutputDevices = withSelectedDeviceFallback(mergeDevices(audioOutputDevices, detectedDevices.audiooutput), selectedAudioOutput, "Current speaker", "audiooutput");
  const effectiveVideoInputDevices = withSelectedDeviceFallback(mergeDevices(videoInputDevices, detectedDevices.videoinput), selectedVideoInput, "Current camera", "videoinput");
  const showLeave = buttonsToRender.includes("leave");

  return {
    themeVariables,
    buttonsToRender,
    effectiveAudioInputDevices,
    effectiveAudioOutputDevices,
    effectiveVideoInputDevices,
    showLeave,
  };
}

interface ConnectedControlBarBehavior {
  readonly surfaceProps: ControlBarSurfaceProps;
  readonly commandError: ClientFailure | null;
}

export function useConnectedControlBarBehavior(props: ControlBarProps): ConnectedControlBarBehavior {
  const [mirrored, setMirrored] = useMirrorSetting();
  const client = useSpaceClient();
  const self = useSelf();
  const participants = useParticipants();
  const media = useMedia();
  const chat = useChat();
  const recording = useRecording();
  const canPublishScreen = useCan("publishScreen");
  const canSendReaction = useCan("sendReaction");
  const canRaiseHand = useCan("raiseHand");
  const canDrawWhiteboard = useCan("drawWhiteboard");
  const canManageRecording = useCan("manageRecording");
  const microphoneEnabled = media.local.microphone.state === "enabled";
  const cameraEnabled = media.local.camera.state === "enabled";
  const screenSharing = media.local.screen.state === "enabled" || media.local.screen.state === "requesting";
  const recordingStatus = recording.current?.status;
  const isRecording = recordingStatus === "recording" || recordingStatus === "stopping";
  const isRecordingPending = recordingStatus === "starting" || recordingStatus === "stopping";
  const [noiseSuppression, setNoiseSuppression] = useState(true);
  const [commandError, setCommandError] = useState<ClientFailure | null>(null);

  const run = useCallback(
    async (command: () => Promise<unknown>, source?: MediaSource) => {
      setCommandError(null);
      props.onCommandError?.(null, source);
      try {
        await command();
      } catch (cause) {
        const failure = commandFailure(cause);
        if (!props.onCommandError) setCommandError(failure);
        props.onCommandError?.(failure, source);
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
    if (button === "reactions") return canSendReaction;
    if (button === "handraise") return canRaiseHand;
    if (button === "whiteboard") return canDrawWhiteboard;
    if (button === "record") return canManageRecording;
    return true;
  });
  const audioInputDevices: MediaDevice[] = media.devices.microphones.map((device) => ({ ...device, kind: "audioinput" }));
  const audioOutputDevices: MediaDevice[] = media.devices.speakers.map((device) => ({ ...device, kind: "audiooutput" }));
  const videoInputDevices: MediaDevice[] = media.devices.cameras.map((device) => ({ ...device, kind: "videoinput" }));
  const surfaceProps: ControlBarSurfaceProps = {
    ...props,
    detectDevices: false,
    buttons,
    microphoneTrack: media.local.microphone.track,
    cameraTrack: media.local.camera.track,
    mirrored: props.mirrored ?? mirrored,
    onMirrorChange: props.onMirrorChange ?? (props.mirrored === undefined ? setMirrored : undefined),
    microphoneWarning: media.local.microphone.state === "failed" || media.local.microphone.state === "unavailable",
    cameraWarning: media.local.camera.state === "failed" || media.local.camera.state === "unavailable",
    noiseSuppression,
    onNoiseSuppressionChange: media.local.microphone.track
      ? (enabled) =>
          void run(async () => {
            await media.local.microphone.track?.applyConstraints({ noiseSuppression: enabled });
            setNoiseSuppression(enabled);
          }, "microphone")
      : undefined,
    onStartScreenShare: (options) =>
      void run(async () => {
        if (screenSharing) await client.media.setScreenShareEnabled(false);
        await client.media.setScreenShareEnabled(true, options);
      }, "screen"),
    shareUrl: props.shareUrl,
    isMuted: !microphoneEnabled,
    microphonePending: media.local.microphone.state === "requesting",
    cameraPending: media.local.camera.state === "requesting",
    isVideoEnabled: cameraEnabled,
    isScreenSharing: screenSharing,
    isRecording,
    isRecordingPending,
    isChatOpen: props.activePanel === "chat",
    isParticipantsOpen: props.activePanel === "participants",
    isHandRaised: self.handRaised,
    unreadChatCount: chat.unreadCount,
    knockCount: self.can("manageAdmission") ? participants.admissionQueue.length : 0,
    audioInputDevices,
    audioOutputDevices,
    videoInputDevices,
    selectedAudioInput: media.selection.microphone ?? undefined,
    selectedAudioOutput: media.selection.speaker ?? undefined,
    selectedVideoInput: media.selection.camera ?? undefined,
    onTestSpeaker: () =>
      void run(async () => {
        const context = new AudioContext();
        const oscillator = context.createOscillator();
        const gain = context.createGain();
        const output = context.createMediaStreamDestination();
        const audio = new Audio();
        try {
          if (media.selection.speaker && audio.setSinkId) await audio.setSinkId(media.selection.speaker);
          audio.srcObject = output.stream;
          oscillator.connect(gain).connect(output);
          gain.gain.value = 0.15;
          oscillator.frequency.value = 440;
          oscillator.start();
          await audio.play();
          await new Promise<void>((resolve) => {
            oscillator.onended = () => resolve();
            oscillator.stop(context.currentTime + 0.4);
          });
        } finally {
          audio.pause();
          audio.srcObject = null;
          oscillator.disconnect();
          gain.disconnect();
          output.stream.getTracks().forEach((track) => track.stop());
          await context.close();
        }
      }),
    onToggleMute: () => void run(() => client.media.setMicrophoneEnabled(!microphoneEnabled), "microphone"),
    onToggleVideo: () => void run(() => client.media.setCameraEnabled(!cameraEnabled), "camera"),
    onAudioInputChange: (deviceId) => void run(() => client.media.selectMicrophone(deviceId), "microphone"),
    onAudioOutputChange: (deviceId) => void run(() => client.media.selectSpeaker(deviceId)),
    onVideoInputChange: (deviceId) => void run(() => client.media.selectCamera(deviceId), "camera"),
    onToggleScreenShare: () => void run(() => client.media.setScreenShareEnabled(!screenSharing), "screen"),
    onToggleRecording: () => void run(() => (recordingStatus === "recording" ? client.recording.stop() : client.recording.start())),
    onToggleChat: props.onToggleChat,
    onToggleParticipants: props.onToggleParticipants,
    onToggleHandRaise: () => void run(() => (self.handRaised ? client.participants.lowerHand() : client.participants.raiseHand())),
    onToggleWhiteboard: props.onToggleWhiteboard,
    onOpenReactions: props.onOpenReactions,
    onLeft: leave,
    onEndForEveryone: props.onEndForEveryone,
  };

  return { surfaceProps, commandError };
}
