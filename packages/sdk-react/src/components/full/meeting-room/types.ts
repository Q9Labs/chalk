import type { MediaDevice } from "@q9labs/chalk-core";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

export type MeetingPanel = "chat" | "participants" | "transcription";
export type MeetingLayout = "grid" | "spotlight" | "sidebar";

export interface Participant {
  id: string;
  displayName: string;
  isLocal?: boolean;
  isSpeaking?: boolean;
  isMuted?: boolean;
  isVideoEnabled?: boolean;
  isScreenSharing?: boolean;
  isHandRaised?: boolean;
  connectionQuality?: 1 | 2 | 3 | 4;
  avatarUrl?: string;
  videoTrack?: MediaStreamTrack | null;
  audioTrack?: MediaStreamTrack | null;
  screenShareTrack?: MediaStreamTrack | null;
  screenShareAudioTrack?: MediaStreamTrack | null;
  role?: "host" | "co-host" | "participant";
}

export interface ChatMessage {
  id: string;
  senderId: string;
  senderName: string;
  content: string;
  timestamp: Date;
  attachments?: Array<{
    id: string;
    fileName: string;
    mimeType: string;
    sizeBytes: number;
    kind: "image" | "document" | "file";
  }>;
  readBy?: Array<{
    participantId: string;
    displayName: string;
    readAt: Date;
  }>;
  isLocal?: boolean;
}

export interface TranscriptEntry {
  id: string;
  speaker: string;
  speakerId: string;
  text: string;
  timestamp: Date;
  isInterim?: boolean;
  confidence?: number;
}

export interface ActiveReaction {
  id: string;
  participantId: string;
  participantName: string;
  emoji: string;
  timestamp: Date;
}

export interface MeetingRoomProps {
  roomName: string;
  localParticipant: Participant;
  participants: Participant[];
  canManageParticipants?: boolean;
  onToggleParticipantMute?: (participantId: string) => void;
  onRemoveParticipant?: (participantId: string) => void;
  onUpdateDisplayName?: (displayName: string) => void;
  activeReactions?: readonly ActiveReaction[];
  isMuted?: boolean;
  isVideoEnabled?: boolean;
  isScreenSharing?: boolean;
  isHandRaised?: boolean;
  isWhiteboardOpen?: boolean;
  isRecording?: boolean;
  recordingDuration?: number;
  meetingDuration?: number;
  canRecord?: boolean;
  isTranscribing?: boolean;
  transcripts?: TranscriptEntry[];
  chatMessages?: ChatMessage[];
  unreadChatCount?: number;
  enablePictureInPicture?: boolean;
  isPictureInPictureActive?: boolean;
  isPictureInPictureSupported?: boolean;
  onSendMessage?: (content: string) => void;
  onSendMessageWithAttachments?: (content: string, files: File[]) => Promise<void>;
  onResolveChatAttachmentUrl?: (attachmentId: string) => Promise<string>;
  onChatOpen?: () => void;
  enableChat?: boolean;
  enableRecording?: boolean;
  enableScreenShare?: boolean;
  enableHandRaise?: boolean;
  enableReactions?: boolean;
  enableWhiteboard?: boolean;
  enableTranscription?: boolean;
  enableTour?: boolean;
  defaultLayout?: MeetingLayout;
  defaultChatOpen?: boolean;
  defaultParticipantsOpen?: boolean;
  defaultTranscriptionOpen?: boolean;
  showTourOnFirstVisit?: boolean;
  showInviteToastOnJoin?: boolean;
  onToggleMute?: () => void;
  onToggleVideo?: () => void;
  onAudioInputChange?: (deviceId: string) => void;
  onAudioOutputChange?: (deviceId: string) => void;
  onVideoInputChange?: (deviceId: string) => void;
  onToggleScreenShare?: () => void;
  onToggleRecording?: () => void;
  onToggleHandRaise?: () => void;
  onToggleWhiteboard?: () => void;
  onSendReaction?: (emoji: string) => void;
  onToggleTranscription?: () => void;
  onTogglePictureInPicture?: () => Promise<void> | void;
  onLeave?: () => void;
  onTourComplete?: () => void;
  onAddPeople?: () => void;
  connectionState?: "connected" | "connecting" | "reconnecting" | "failed";
  onRetryConnection?: () => void;
  connectionSupportCode?: string;
  audioInputDevices?: readonly MediaDevice[];
  audioOutputDevices?: readonly MediaDevice[];
  videoInputDevices?: readonly MediaDevice[];
  selectedAudioInput?: string;
  participantVolumes?: ReadonlyMap<string, number>;
  onParticipantVolumeChange?: (id: string, volume: number) => void;
  getParticipantVolume?: (participantId: string) => number;
  selectedAudioOutput?: string;
  selectedVideoInput?: string;
  theme?: "light" | "dark" | "system";
  onWhiteboardExcalidrawApiReady?: (api: ExcalidrawImperativeAPI) => void;
  className?: string;
}
