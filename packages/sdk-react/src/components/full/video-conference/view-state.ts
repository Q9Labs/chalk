import type { MeetingRoomProps } from "../MeetingRoom";
import type { PreJoinLobbyProps } from "../prejoin-lobby/types";
import type { Phase } from "./types";

export interface VideoConferenceControllerState {
  phase: Phase;
  preJoinProps: PreJoinLobbyProps;
  meetingRoomProps: MeetingRoomProps;
  endScreenProps: {
    roomName: string;
    duration: number;
    participantCount: number;
    hasRecording: boolean;
    onRejoin: () => void;
    onGoHome: () => void;
    className?: string;
  };
  leaveDialogProps: {
    isOpen: boolean;
    onClose: () => void;
    onConfirm: () => void;
  };
}

interface BuildVideoConferenceViewStateParams {
  roomName: string;
  userName: string;
  onJoin: PreJoinLobbyProps["onJoin"];
  videoTrack: PreJoinLobbyProps["videoTrack"];
  videoDevices: PreJoinLobbyProps["videoDevices"];
  audioInputDevices: PreJoinLobbyProps["audioInputDevices"];
  audioOutputDevices: PreJoinLobbyProps["audioOutputDevices"];
  selectedVideoDevice: PreJoinLobbyProps["selectedVideoDevice"];
  selectedAudioInput: PreJoinLobbyProps["selectedAudioInput"];
  selectedAudioOutput: PreJoinLobbyProps["selectedAudioOutput"];
  onVideoDeviceChange: PreJoinLobbyProps["onVideoDeviceChange"];
  onAudioInputChange: PreJoinLobbyProps["onAudioInputChange"];
  onAudioOutputChange: PreJoinLobbyProps["onAudioOutputChange"];
  initialVideoEnabled: PreJoinLobbyProps["initialVideoEnabled"];
  initialAudioEnabled: PreJoinLobbyProps["initialAudioEnabled"];
  isLoading: PreJoinLobbyProps["isLoading"];
  error: PreJoinLobbyProps["error"];
  supportCode: PreJoinLobbyProps["supportCode"];
  className: PreJoinLobbyProps["className"];
  meetingDuration: number;
  participantCount: number;
  hasRecording: boolean;
  onRejoin: () => void;
  onGoHome: () => void;
  isLeaveDialogOpen: boolean;
  onCloseLeaveDialog: () => void;
  onConfirmLeaveDialog: () => void;
}

export function buildVideoConferenceViewState({
  roomName,
  userName,
  onJoin,
  videoTrack,
  videoDevices,
  audioInputDevices,
  audioOutputDevices,
  selectedVideoDevice,
  selectedAudioInput,
  selectedAudioOutput,
  onVideoDeviceChange,
  onAudioInputChange,
  onAudioOutputChange,
  initialVideoEnabled,
  initialAudioEnabled,
  isLoading,
  error,
  supportCode,
  className,
  meetingDuration,
  participantCount,
  hasRecording,
  onRejoin,
  onGoHome,
  isLeaveDialogOpen,
  onCloseLeaveDialog,
  onConfirmLeaveDialog,
}: BuildVideoConferenceViewStateParams): Omit<VideoConferenceControllerState, "phase" | "meetingRoomProps"> {
  return {
    preJoinProps: {
      roomName,
      userName,
      onJoin,
      videoTrack,
      videoDevices,
      audioInputDevices,
      audioOutputDevices,
      selectedVideoDevice,
      selectedAudioInput,
      selectedAudioOutput,
      onVideoDeviceChange,
      onAudioInputChange,
      onAudioOutputChange,
      initialVideoEnabled,
      initialAudioEnabled,
      isLoading,
      error,
      supportCode,
      className,
    },
    endScreenProps: {
      roomName,
      duration: meetingDuration,
      participantCount,
      hasRecording,
      onRejoin,
      onGoHome,
      className,
    },
    leaveDialogProps: {
      isOpen: isLeaveDialogOpen,
      onClose: onCloseLeaveDialog,
      onConfirm: onConfirmLeaveDialog,
    },
  };
}
