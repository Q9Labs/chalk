export interface JoinSettings {
  displayName: string;
  videoEnabled: boolean;
  audioEnabled: boolean;
  selectedVideoDevice?: string;
  selectedAudioInput?: string;
  selectedAudioOutput?: string;
}

export interface PreJoinLobbyProps {
  roomName?: string;
  userName?: string;
  onJoin: (settings: JoinSettings) => void;
  onCancel?: () => void;
  enablePictureInPicture?: boolean;
  isPictureInPictureActive?: boolean;
  isPictureInPictureSupported?: boolean;
  onTogglePictureInPicture?: () => Promise<void> | void;

  videoTrack?: MediaStreamTrack | null;
  audioTrack?: MediaStreamTrack | null;
  audioLevel?: number;

  videoDevices?: MediaDeviceInfo[];
  audioInputDevices?: MediaDeviceInfo[];
  audioOutputDevices?: MediaDeviceInfo[];
  selectedVideoDevice?: string;
  selectedAudioInput?: string;
  selectedAudioOutput?: string;
  onVideoDeviceChange?: (deviceId: string) => void;
  onAudioInputChange?: (deviceId: string) => void;
  onAudioOutputChange?: (deviceId: string) => void;

  initialVideoEnabled?: boolean;
  initialAudioEnabled?: boolean;
  initialShowSettings?: boolean;

  isLoading?: boolean;
  error?: string;
  supportCode?: string;

  participantGradient?: string;

  /** Initial theme - defaults to 'dark' */
  initialTheme?: "light" | "dark";

  className?: string;
}
