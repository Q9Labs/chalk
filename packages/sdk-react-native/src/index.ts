/**
 * @q9labs/chalk-react-native - React Native SDK for Chalk video conferencing
 *
 * This package provides React Native bindings for the Chalk video conferencing platform,
 * built on Cloudflare RealtimeKit and react-native-webrtc.
 *
 * @packageDocumentation
 * @module @q9labs/chalk-react-native
 *
 * @example
 * ```tsx
 * import { ChalkProvider, useRoom, useParticipants, useMedia } from '@q9labs/chalk-react-native';
 * import { VideoView, AudioSession } from '@q9labs/chalk-react-native/components';
 *
 * export default function App() {
 *   return (
 *     <ChalkProvider token="your-jwt-token">
 *       <CallScreen />
 *     </ChalkProvider>
 *   );
 * }
 *
 * function CallScreen() {
 *   const { joinSession } = useChalk();
 *   const { participants } = useParticipants();
 *   const { isVideoEnabled, toggleVideo } = useMedia();
 *
 *   return (
 *     <AudioSession useSpeaker={true}>
 *       <VideoGrid participants={participants} />
 *       <Controls
 *         isVideoEnabled={isVideoEnabled}
 *         onToggleVideo={toggleVideo}
 *       />
 *     </AudioSession>
 *   );
 * }
 * ```
 */

// Re-export core types for convenience
export type {
  ConferenceClientConfig,
  ChalkError,
  ChatMessage,
  Err,
  MediaDevice,
  MediaDeviceKind,
  Ok,
  Participant,
  Reaction,
  ReactionEmoji,
  Recording,
  RecordingStatus,
  Result,
  ConferenceSession,
  JoinSessionConfig,
  SessionInfo,
  SessionConnectionState,
  ScreenShareOptions,
  TrackKind,
} from "@q9labs/chalk-core";
// Re-export error codes (value export also exports the type)
export { ChalkErrorCode } from "@q9labs/chalk-core";
// Logger
export { createLogger, logger, type ChalkLogger } from "./logger";
// Provider and hooks
export { ChalkProvider, type ChalkProviderProps, useChalk } from "./ChalkProvider";
// Theme
export { CHALK_THEME, type ChalkTheme } from "./theme";
// Icons (LineIcons)
export { CameraIcon, ChatIcon, CheckIcon, CloseIcon, HandRaisedIcon, MicrophoneIcon, MutedIcon, PhoneIcon, ScreenShareIcon, SendIcon, SpeakingIcon, SwitchCameraIcon, VideoIcon } from "./icons";
// Components
export { AudioSession, Avatar, ChatPanel, ControlBar, DeviceSelector, EndScreen, MeetingRoom, ParticipantTile, PreJoinLobby, ScreenShareView, useBluetoothAudio, useSpeakerphone, VideoConference, VideoGrid, VideoView } from "./components/index";
// Hooks
export {
  type ActiveReaction,
  type AudioRoute,
  type PermissionStatus,
  type PermissionsState,
  type UseAudioRoutingResult,
  type UseCallKitResult,
  type UseChatResult,
  type UseDevicesResult,
  type UseForegroundServiceResult,
  type UseInteractionsReturn,
  type UseLocalStreamResult,
  type UseMediaResult,
  type UseParticipantsResult,
  type UsePermissionsResult,
  type UseRecordingResult,
  type UseRoomResult,
  type UseScreenShareResult,
  useAudioRouting,
  useCallKit,
  useChat,
  useDevices,
  useForegroundService,
  useHandRaise,
  useInteractions,
  useLocalStream,
  useMedia,
  useParticipants,
  usePermissions,
  useRecording,
  useRoom,
  useScreenShare,
} from "./hooks/index";
