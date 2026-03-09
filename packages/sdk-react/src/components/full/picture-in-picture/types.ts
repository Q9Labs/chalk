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
}

export interface PictureInPictureControls {
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
  onToggleScreenShare?: () => void;
  onToggleHandRaise?: () => void;
  onToggleWhiteboard?: () => void;
  onOpenReactions?: () => void;
  onLeave?: () => void;
}
