import type { CameraPreview, ClientFailure, MediaSource, ScreenShareOptions } from "@q9labsai/chalk-client";
import type { MediaCommandAction, MediaCommandSource } from "./command-failure";
import type { MediaDevice } from "./control-bar-devices";
import type { ParticipantGradientPreference } from "../../utils/colorGenerator";
import type { DeviceAccessControl } from "../device-access/DeviceAccessCard";
import type { DeviceKind } from "../device-access/model";

export type ControlBarButtonName = "mic" | "video" | "screenshare" | "record" | "chat" | "participants" | "handraise" | "reactions" | "whiteboard" | "presenting" | "leave";

export type ControlBarMicrophonePicker = { readonly open: boolean; readonly onOpenChange: (open: boolean) => void };

export interface ControlBarSurfaceProps {
  layout?: "focus" | "grid";
  onLayoutChange?: (layout: "focus" | "grid") => void;
  density?: "comfortable" | "compact";
  buttons?: ControlBarButtonName[];

  microphoneTrack?: MediaStreamTrack | null;
  microphonePicker?: ControlBarMicrophonePicker;
  cameraTrack?: MediaStreamTrack | null;
  captureCameraPreview?: () => Promise<CameraPreview>;
  microphoneWarning?: boolean;
  cameraWarning?: boolean;
  /** A device the browser or the system refuses. Its dock button shows a ring and a badge and opens the access card. */
  deviceAccess?: Partial<Record<DeviceKind, DeviceAccessControl>>;
  speakingWhileMuted?: boolean;
  noiseSuppression?: boolean;
  onNoiseSuppressionChange?: (enabled: boolean) => void;
  mirrored?: boolean;
  onMirrorChange?: (mirrored: boolean) => void;
  onTestSpeaker?: () => void;
  onStartScreenShare?: (options: ScreenShareOptions) => void;
  knockCount?: number;
  isMuted?: boolean;
  microphonePending?: boolean;
  onCancelMicrophonePending?: () => void;
  mediaEnableDisabled?: boolean;
  reactionsDisabled?: boolean;
  cameraPending?: boolean;
  onCancelCameraPending?: () => void;
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
  /** Opens the Present file picker. */
  onPresent?: () => void;
  /** One of this person's Documents is on the Stage. */
  isPresenting?: boolean;
  /** What the Stage accepts, shown beside Present a file. */
  presentHint?: string;
  onOpenReactions?: () => void;
  /** The reactions tray is open; the button reports it with aria-expanded. */
  reactionsOpen?: boolean;
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

export interface ConnectedControlBarProps {
  /** Control the existing microphone picker from elsewhere in the call. */
  readonly microphonePicker?: ControlBarMicrophonePicker;
  /** Local self-view only. Omit to use the persisted mirror preference. */
  readonly mirrored?: boolean;
  readonly onMirrorChange?: (mirrored: boolean) => void;
  readonly layout?: "focus" | "grid";
  readonly onLayoutChange?: (layout: "focus" | "grid") => void;
  readonly density?: "comfortable" | "compact";
  readonly buttons?: ControlBarButtonName[];
  readonly activePanel?: "chat" | "participants" | null;
  readonly onToggleChat?: () => void;
  readonly onToggleParticipants?: () => void;
  readonly onToggleWhiteboard?: () => void;
  readonly isWhiteboardOpen?: boolean;
  readonly onPresent?: () => void;
  readonly isPresenting?: boolean;
  readonly presentHint?: string;
  readonly onOpenReactions?: () => void;
  readonly reactionsOpen?: boolean;
  readonly onLeaveRequest?: () => void;
  /** Set for hosts: the leave button opens a menu with Leave call and End call for everyone. */
  readonly onEndForEveryone?: () => void;
  readonly onLeft?: () => void;
  /** The second argument retains the published MediaSource contract; the third also identifies speaker commands. */
  readonly onCommandError?: (failure: ClientFailure | null, source?: MediaSource, commandSource?: MediaCommandSource, action?: MediaCommandAction, retryCommand?: () => Promise<unknown>) => void;
  readonly participantColorSeed?: string;
  readonly participantGradientPreference?: ParticipantGradientPreference;
  readonly className?: string;
}

export const DEFAULT_CONTROL_BAR_BUTTONS: ControlBarButtonName[] = ["mic", "video", "screenshare", "record", "whiteboard", "presenting", "handraise", "leave", "participants", "chat", "reactions"];
