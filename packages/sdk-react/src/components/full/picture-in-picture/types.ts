import type { MediaDevice } from "@q9labs/chalk-core";
import type { ParticipantGradientPreference } from "../../../utils/colorGenerator";

export type PictureInPicturePhase = "prejoin" | "joining" | "meeting";

export type PictureInPictureSourceKind = "participant" | "screen-share" | "whiteboard" | "placeholder";
export type PictureInPictureMeetingLayout = "single" | "split" | "grid" | "screen-share";

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
  isHandRaised?: boolean;
  whiteboardSnapshot?: {
    elements: readonly unknown[];
    appState: Record<string, unknown>;
    files: Record<string, unknown>;
    key: string;
  };
}

export interface PictureInPictureControls {
  localParticipantGradientPreference?: ParticipantGradientPreference;
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
  onSendReaction?: (emoji: string) => void;
  onJoin?: () => void;
  onLeave?: () => void;
  loadingMessages?: readonly string[];
  errorMessage?: string;
  supportCode?: string;
}
