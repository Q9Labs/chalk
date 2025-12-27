/**
 * @chalk/react - React SDK for Chalk video conferencing
 *
 * @packageDocumentation
 * @module @chalk/react
 *
 * @example
 * ```tsx
 * import { ChalkProvider, useRoom, useParticipants, VideoGrid } from '@chalk/react';
 *
 * function App() {
 *   return (
 *     <ChalkProvider token="jwt_xxx">
 *       <MeetingRoom roomId="room_123" />
 *     </ChalkProvider>
 *   );
 * }
 *
 * function MeetingRoom({ roomId }: { roomId: string }) {
 *   const { isConnected } = useRoom();
 *   const { participants } = useParticipants();
 *
 *   if (!isConnected) return <div>Connecting...</div>;
 *
 *   return <VideoGrid participants={participants} />;
 * }
 * ```
 */

// Re-export useful types from core
export type {
	ChalkError,
	ChatMessage,
	MediaDevice,
	Participant,
	Reaction,
	ReactionEmoji,
	Recording,
	Room,
	RoomConfig,
	RoomInfo,
	RoomStatus,
	ScreenShareOptions,
} from "@chalk/core";
// Re-export error codes
export { ChalkErrorCode } from "@chalk/core";

// Components
export {
	Controls,
	type ControlsProps,
	VideoGrid,
	type VideoGridProps,
	VideoTile,
	type VideoTileProps,
} from "./components/index.ts";
// Context and Provider
export {
	ChalkProvider,
	type ChalkProviderProps,
	useChalk,
} from "./context.tsx";
// Hooks
export {
	type UseChatResult,
	type UseDevicesResult,
	type UseMediaResult,
	type UseParticipantsResult,
	type UseRecordingResult,
	type UseRoomResult,
	useChat,
	useDevices,
	useMedia,
	useParticipants,
	useRecording,
	useRoom,
} from "./hooks/index.ts";
