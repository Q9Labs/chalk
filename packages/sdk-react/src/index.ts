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

// Context and Provider
export { ChalkProvider, useChalk, type ChalkProviderProps } from './context.tsx';

// Hooks
export {
  useRoom,
  useParticipants,
  useMedia,
  useChat,
  useRecording,
  useDevices,
  type UseRoomResult,
  type UseParticipantsResult,
  type UseMediaResult,
  type UseChatResult,
  type UseRecordingResult,
  type UseDevicesResult,
} from './hooks/index.ts';

// Components
export {
  VideoGrid,
  VideoTile,
  Controls,
  type VideoGridProps,
  type VideoTileProps,
  type ControlsProps,
} from './components/index.ts';

// Re-export useful types from core
export type {
  Room,
  Participant,
  ChatMessage,
  RoomConfig,
  RoomStatus,
  RoomInfo,
  ScreenShareOptions,
  ReactionEmoji,
  Reaction,
  Recording,
  MediaDevice,
  ChalkError,
} from '@chalk/core';

// Re-export error codes
export { ChalkErrorCode } from '@chalk/core';
