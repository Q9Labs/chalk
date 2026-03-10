import type { MediaDevice } from "@q9labs/chalk-core";

export type PictureInPicturePhase = "prejoin" | "meeting";

export type PictureInPictureSourceKind = "participant" | "screen-share" | "placeholder";

export interface PictureInPictureSource {
  id: string;
  kind: PictureInPictureSourceKind;
  title: string;
  subtitle?: string;
  videoTrack?: MediaStreamTrack | null;
  avatarUrl?: string;
  isMuted?: boolean;
  isLocal?: boolean;
  isSpeaking?: boolean;
}

export interface PictureInPictureControls {
  audioInputDevices?: readonly MediaDevice[];
  audioOutputDevices?: readonly MediaDevice[];
  videoInputDevices?: readonly MediaDevice[];
  selectedAudioInput?: string;
  selectedAudioOutput?: string;
  selectedVideoInput?: string;
  isMuted?: boolean;
  isVideoEnabled?: boolean;
  isScreenSharing?: boolean;
  isHandRaised?: boolean;
  isWhiteboardOpen?: boolean;
  enableScreenShare?: boolean;
  enableHandRaise?: boolean;
  enableWhiteboard?: boolean;
  enableReactions?: boolean;
  onToggleMute?: () => void;
  onToggleVideo?: () => void;
  onAudioInputChange?: (deviceId: string) => void;
  onAudioOutputChange?: (deviceId: string) => void;
  onVideoInputChange?: (deviceId: string) => void;
  onToggleScreenShare?: () => void;
  onToggleHandRaise?: () => void;
  onToggleWhiteboard?: () => void;
  onOpenReactions?: () => void;
  onLeave?: () => void;
}
