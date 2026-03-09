import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useChalkSession } from "../../../context/chalk-provider";
import { useChat } from "../../../hooks/features/useChat";
import { useInteractions } from "../../../hooks/features/useInteractions";
import { useRecording } from "../../../hooks/features/useRecording";
import { useTranscripts } from "../../../hooks/features/useTranscripts";
import { useWhiteboard } from "../../../hooks/features/useWhiteboard";
import { useActiveSpeaker } from "../../../hooks/participants/useActiveSpeaker";
import { useParticipants } from "../../../hooks/participants/useParticipants";
import { useConnection } from "../../../hooks/room/useConnection";
import { useRoom } from "../../../hooks/room/useRoom";
import { useDevices } from "../../../hooks/stream/useDevices";
import { useMedia } from "../../../hooks/stream/useMedia";
import { useScreenShare } from "../../../hooks/stream/useScreenShare";
import { useLayout } from "../../../hooks/ui/useLayout";
import { usePanels } from "../../../hooks/ui/usePanels";
import { useParticipantVolume } from "../../../hooks/ui/useParticipantVolume";
import { useSoundEffects } from "../../../hooks/useSoundEffects";
import { cn } from "../../../utils/cn";
import type { Features, Phase, VideoConferenceProps } from "./types";
import { useChatNotifications } from "./useChatNotifications";
import { useConferenceConnectionState } from "./useConferenceConnectionState";
import { useConferenceErrorReporter } from "./useConferenceErrorReporter";
import { useConferenceFeatureFlags } from "./useConferenceFeatureFlags";
import { useConferenceLifecycleState } from "./useConferenceLifecycleState";
import { useConferenceMeetingActions } from "./useConferenceMeetingActions";
import { useJoinFlow } from "./useJoinFlow";
import { useLobbyDevices } from "./useLobbyDevices";
import { useMeetingStats } from "./useMeetingStats";
import { useVideoConferenceMeetingRoomProps } from "./useVideoConferenceMeetingRoomProps";
import { useSessionEvents } from "./useSessionEvents";
import {
  buildVideoConferenceViewState,
  type VideoConferenceControllerState,
} from "./view-state";

const DISCONNECT_GRACE_MS = 8000;
const EMPTY_FEATURES: Features = {};
const EMPTY_DEFAULTS: NonNullable<VideoConferenceProps["defaults"]> = {};

export function useVideoConferenceController({
  roomId,
  roomName,
  userName,
  autoJoin = false,
  role,
  metadata,
  features,
  defaults,
  sounds = true,
  onJoin,
  onLeave,
  onEnd,
  onError,
  onAddPeople,
  whiteboard: whiteboardOptions,
  className,
}: VideoConferenceProps): VideoConferenceControllerState {
  const resolvedFeatures = features ?? EMPTY_FEATURES;
  const resolvedDefaults = defaults ?? EMPTY_DEFAULTS;

  const [phase, setPhase] = useState<Phase>("lobby");
  const [error, setError] = useState<string | null>(null);
  const [showLeaveConfirm, setShowLeaveConfirm] = useState(false);
  const [isExiting, setIsExiting] = useState(false);
  const autoJoinStartedRef = useRef(false);

  const effectiveRoomName = roomName ?? roomId;

  const { join, leave, isJoining } = useConnection();
  const { isConnected, status } = useRoom();
  const {
    participants,
    localParticipant,
    participantCount,
    updateDisplayName,
  } = useParticipants();
  const { activeSpeaker } = useActiveSpeaker();
  const media = useMedia();
  const screenShare = useScreenShare();
  const {
    messages,
    sendMessage: sendChatMessage,
    sendMessageWithAttachments: sendChatMessageWithAttachments,
    getAttachmentDownloadUrl,
    unreadCount,
    markAsRead,
  } = useChat();
  const recording = useRecording();
  const interactions = useInteractions();
  const whiteboard = useWhiteboard();
  const { layout } = useLayout();
  const { activePanel } = usePanels();
  const { participantVolumes, setParticipantVolume, getAudioVolume } =
    useParticipantVolume();
  const {
    refreshDevices,
    cameras,
    microphones,
    speakers: audioOutputs,
  } = useDevices();

  const {
    lastWsToastAtRef,
    roomIdRef,
    phaseRef,
    localParticipantIdRef,
    disconnectGraceTimeoutRef,
    isDisconnectGraceActive,
    setIsDisconnectGraceActive,
    clearDisconnectGraceTimeout,
  } = useConferenceLifecycleState({
    phase,
    status,
    roomId,
    localParticipantId: localParticipant?.id,
  });

  const {
    lobbySelectedCamera,
    setLobbySelectedCamera,
    lobbySelectedMicrophone,
    setLobbySelectedMicrophone,
    lobbySelectedSpeaker,
    setLobbySelectedSpeaker,
  } = useLobbyDevices({
    refreshDevices,
    cameras,
    microphones,
    audioOutputs,
    selectedCamera: media.selectedCamera,
    selectedMicrophone: media.selectedMicrophone,
    selectedSpeaker: media.selectedSpeaker,
  });

  const { session } = useChalkSession();
  const { play } = useSoundEffects({ enabled: sounds, autoSubscribe: true });
  const { transcripts: rawTranscripts } = useTranscripts();
  const committedTranscripts = useMemo(
    () => rawTranscripts.filter((transcript) => transcript.isInterim !== true),
    [rawTranscripts],
  );
  const transcripts = useMemo(
    () =>
      rawTranscripts.map((transcript) => ({
        id: transcript.id,
        speaker: transcript.speakerName,
        speakerId: transcript.participantId,
        text: transcript.text,
        timestamp: transcript.timestamp,
        isInterim: transcript.isInterim,
        confidence: transcript.confidence,
      })),
    [rawTranscripts],
  );

  const pushIncidentBreadcrumb = useCallback(
    (category: string, message: string, data?: Record<string, unknown>) => {
      session.recordIncidentBreadcrumb({ category, message, data });
    },
    [session],
  );

  const { supportCode, setSupportCode, emitError } = useConferenceErrorReporter(
    {
      session,
      onError,
      roomIdRef,
      phaseRef,
      pushIncidentBreadcrumb,
    },
  );

  const {
    meetingDuration,
    incrementHandRaiseCount,
    buildEndData,
    resetForRejoin,
  } = useMeetingStats({
    phase,
    roomId,
    participants,
    participantCount,
    messagesLength: messages.length,
    committedTranscripts,
    recordingId: recording.recordingId,
    recordingDurationSeconds: recording.durationSeconds,
    isLocalScreenSharing: screenShare.isLocalSharing,
    isWhiteboardOpen: whiteboard.isOpen,
    activeReactionCount: interactions.activeReactions.length,
  });

  const { handleChatOpen } = useChatNotifications({
    phase,
    messages,
    localParticipantId: localParticipant?.id,
    unreadCount,
    markAsRead,
    play,
  });

  const featureFlags = useConferenceFeatureFlags({
    features: resolvedFeatures,
    participants,
    localParticipant,
    participantCount,
    isRecording: recording.isRecording,
  });

  const { handleJoin, handleRetryConnection } = useJoinFlow({
    roomId,
    role,
    metadata,
    join,
    isJoining,
    isConnected,
    localParticipant,
    isRecording: recording.isRecording,
    selectCamera: media.selectCamera,
    selectMicrophone: media.selectMicrophone,
    selectSpeaker: media.selectSpeaker,
    onJoin,
    play,
    emitError,
    pushIncidentBreadcrumb,
    setPhase,
    setError,
    setSupportCode,
    phaseRef,
    roomIdRef,
  });

  const {
    handleLeave,
    initiateLeave,
    handleRejoin,
    handleGoHome,
    handleToggleMute,
    handleToggleVideo,
    handleToggleScreenShare,
    handleToggleRecording,
    handleToggleHandRaise,
    handleSendReaction,
    handleSendMessage,
    handleSendMessageWithAttachments,
  } = useConferenceMeetingActions({
    clearDisconnectGraceTimeout,
    setShowLeaveConfirm,
    setIsExiting,
    setIsDisconnectGraceActive,
    leave,
    play,
    onEnd,
    buildEndData,
    setPhase,
    onLeave,
    setSupportCode,
    resetForRejoin,
    media,
    screenShare,
    recording,
    interactions,
    incrementHandRaiseCount,
    sendChatMessage,
    sendChatMessageWithAttachments,
  });

  const { connectionState } = useConferenceConnectionState({
    status,
    phase,
    isConnected,
    isDisconnectGraceActive,
    setPhase,
  });

  useSessionEvents({
    session,
    phase,
    roomIdRef,
    localParticipantIdRef,
    lastWsToastAtRef,
    disconnectGraceMs: DISCONNECT_GRACE_MS,
    clearDisconnectGraceTimeout,
    setIsDisconnectGraceActive,
    setError,
    setPhase,
    pushIncidentBreadcrumb,
    emitError,
    buildEndData,
    onEnd,
    onLeave,
    disconnectGraceTimeoutRef,
  });

  const selectedCamera = media.selectedCamera ?? lobbySelectedCamera;
  const selectedMicrophone =
    media.selectedMicrophone ?? lobbySelectedMicrophone;

  useEffect(() => {
    if (!autoJoin || phase !== "lobby" || autoJoinStartedRef.current) {
      return;
    }

    autoJoinStartedRef.current = true;
    void handleJoin({
      displayName: userName,
      videoEnabled: resolvedDefaults.videoEnabled ?? true,
      audioEnabled: resolvedDefaults.audioEnabled ?? true,
      selectedVideoDevice: lobbySelectedCamera ?? undefined,
      selectedAudioInput: lobbySelectedMicrophone ?? undefined,
      selectedAudioOutput: lobbySelectedSpeaker ?? undefined,
    });
  }, [
    autoJoin,
    handleJoin,
    lobbySelectedCamera,
    lobbySelectedMicrophone,
    lobbySelectedSpeaker,
    phase,
    resolvedDefaults.audioEnabled,
    resolvedDefaults.videoEnabled,
    userName,
  ]);

  useEffect(() => {
    if (phase !== "meeting") {
      return;
    }

    void refreshDevices().catch((error) => {
      pushIncidentBreadcrumb("media", "In-meeting device refresh failed", {
        message: error instanceof Error ? error.message : String(error),
      });
    });
  }, [phase, pushIncidentBreadcrumb, refreshDevices]);

  const handleMeetingRoomCameraChange = useCallback(
    (deviceId: string) => {
      void media.selectCamera(deviceId).catch((error) => {
        pushIncidentBreadcrumb("media", "In-meeting camera selection failed", {
          deviceId,
          message: error instanceof Error ? error.message : String(error),
        });
      });
    },
    [media, pushIncidentBreadcrumb],
  );

  const handleMeetingRoomMicrophoneChange = useCallback(
    (deviceId: string) => {
      void media.selectMicrophone(deviceId).catch((error) => {
        pushIncidentBreadcrumb(
          "media",
          "In-meeting microphone selection failed",
          {
            deviceId,
            message: error instanceof Error ? error.message : String(error),
          },
        );
      });
    },
    [media, pushIncidentBreadcrumb],
  );

  const handleMeetingRoomSpeakerChange = useCallback(
    (deviceId: string) => {
      void media.selectSpeaker(deviceId).catch((error) => {
        pushIncidentBreadcrumb("media", "In-meeting speaker selection failed", {
          deviceId,
          message: error instanceof Error ? error.message : String(error),
        });
      });
    },
    [media, pushIncidentBreadcrumb],
  );

  const { meetingRoomProps } = useVideoConferenceMeetingRoomProps({
    viewModelParams: {
      participants,
      activeSpeakerId: activeSpeaker?.id,
      userName,
      media,
      screenShare,
      interactions,
      messages,
      localParticipantId: localParticipant?.id,
      defaultsLayout: resolvedDefaults.layout,
      layout,
      lobbySelectedSpeaker,
      localRole: localParticipant?.role,
    },
    moderationSession: session,
    meetingRoomParams: {
      roomName: effectiveRoomName,
      activeReactions: interactions.activeReactions,
      transcripts,
      isMuted: !media.isAudioEnabled,
      isVideoEnabled: media.isVideoEnabled,
      isScreenSharing: screenShare.isLocalSharing,
      isHandRaised: interactions.isHandRaised,
      isWhiteboardOpen: whiteboard.isOpen,
      isRecording: recording.isRecording,
      recordingDuration: recording.durationSeconds,
      meetingDuration,
      featureFlags,
      unreadChatCount: unreadCount,
      handleSendMessage,
      handleSendMessageWithAttachments,
      resolveChatAttachmentUrl: getAttachmentDownloadUrl,
      handleChatOpen,
      handleUpdateDisplayName: updateDisplayName,
      defaultChatOpen: resolvedDefaults.chatOpen ?? activePanel === "chat",
      defaultParticipantsOpen:
        resolvedDefaults.participantsOpen ?? activePanel === "participants",
      audioInputDevices: microphones,
      audioOutputDevices: audioOutputs,
      videoInputDevices: cameras,
      selectedAudioInput: selectedMicrophone,
      selectedVideoInput: selectedCamera,
      handleAudioInputChange: handleMeetingRoomMicrophoneChange,
      handleAudioOutputChange: handleMeetingRoomSpeakerChange,
      handleVideoInputChange: handleMeetingRoomCameraChange,
      handleToggleMute,
      handleToggleVideo,
      handleToggleScreenShare,
      handleToggleRecording,
      handleToggleHandRaise,
      handleToggleWhiteboard: whiteboard.toggle,
      handleSendReaction,
      handleLeave,
      onAddPeople,
      onWhiteboardExcalidrawApiReady: whiteboardOptions?.onExcalidrawApiReady,
      participantVolumes,
      onParticipantVolumeChange: setParticipantVolume,
      getParticipantVolume: getAudioVolume,
      enableBackgroundEffects: featureFlags.backgroundEffects,
      isBackgroundEffectsSupported: media.isBackgroundEffectsSupported,
      isApplyingBackgroundEffect: media.isApplyingBackgroundEffect,
      selectedBackgroundEffect: media.selectedBackgroundEffect,
      handleApplyBackgroundEffect: media.applyBackgroundEffect,
      handleClearBackgroundEffect: media.clearBackgroundEffect,
      connectionState,
      handleRetryConnection,
      connectionSupportCode: supportCode ?? undefined,
      className: cn(className, isExiting && "chalk-animate-exit"),
      isPictureInPictureSupported: false,
      isPictureInPictureActive: false,
      handleTogglePictureInPicture: undefined,
    },
  });

  return {
    phase,
    meetingRoomProps,
    ...buildVideoConferenceViewState({
      roomName: effectiveRoomName,
      userName,
      onJoin: handleJoin,
      videoTrack: localParticipant?.videoTrack,
      videoDevices: cameras as MediaDeviceInfo[],
      audioInputDevices: microphones as MediaDeviceInfo[],
      audioOutputDevices: audioOutputs as MediaDeviceInfo[],
      selectedVideoDevice: lobbySelectedCamera,
      selectedAudioInput: lobbySelectedMicrophone,
      selectedAudioOutput: lobbySelectedSpeaker,
      onVideoDeviceChange: setLobbySelectedCamera,
      onAudioInputChange: setLobbySelectedMicrophone,
      onAudioOutputChange: setLobbySelectedSpeaker,
      initialVideoEnabled: resolvedDefaults.videoEnabled ?? true,
      initialAudioEnabled: resolvedDefaults.audioEnabled ?? true,
      isLoading: phase === "joining" || isJoining,
      error: error ?? undefined,
      supportCode: supportCode ?? undefined,
      enablePictureInPicture: featureFlags.pictureInPicture,
      isPictureInPictureSupported: false,
      isPictureInPictureActive: false,
      onTogglePictureInPicture: undefined,
      className,
      meetingDuration,
      participantCount,
      hasRecording: recording.recordingId !== null,
      onRejoin: handleRejoin,
      onGoHome: handleGoHome,
      isLeaveDialogOpen: showLeaveConfirm,
      onCloseLeaveDialog: () => setShowLeaveConfirm(false),
      onConfirmLeaveDialog: initiateLeave,
    }),
  };
}
