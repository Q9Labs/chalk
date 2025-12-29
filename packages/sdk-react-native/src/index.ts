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
 *   const { joinRoom } = useChalk();
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
	ChalkClientConfig,
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
	Room,
	RoomConfig,
	RoomInfo,
	RoomStatus,
	ScreenShareOptions,
	TrackKind,
} from "@q9labs/chalk-core";
// Re-export error codes (value export also exports the type)
export { ChalkErrorCode } from "@q9labs/chalk-core";
// Provider and hooks
export {
	ChalkProvider,
	type ChalkProviderProps,
	useChalk,
} from "./ChalkProvider";
// Components
export {
	AudioSession,
	ScreenShareView,
	useBluetoothAudio,
	useSpeakerphone,
	VideoView,
} from "./components/index";
// Hooks
export {
	type AudioRoute,
	type PermissionsState,
	type PermissionStatus,
	type UseAudioRoutingResult,
	type UseChatResult,
	type UseDevicesResult,
	type UseMediaResult,
	type UseParticipantsResult,
	type UsePermissionsResult,
	type UseRecordingResult,
	type UseRoomResult,
	type UseScreenShareResult,
	useAudioRouting,
	useChat,
	useDevices,
	useMedia,
	useParticipants,
	usePermissions,
	useRecording,
	useRoom,
	useScreenShare,
} from "./hooks/index";
