/**
 * @chalk/core - Core SDK for Chalk video conferencing
 *
 * @packageDocumentation
 * @module @chalk/core
 *
 * @example
 * ```ts
 * import { ChalkClient } from '@chalk/core';
 *
 * const client = new ChalkClient({ token: 'jwt_xxx' });
 * const room = await client.joinRoom('room_123', {
 *   displayName: 'John Doe',
 *   audio: true,
 *   video: true,
 * });
 *
 * room.on('participant-joined', (p) => console.log(`${p.displayName} joined`));
 * ```
 */

// Main client
export { ChalkClient } from './client.ts';

// Room
export { Room } from './room.ts';

// Types
export type {
  // Result types for error handling
  Result,
  Ok,
  Err,

  // Client config
  ChalkClientConfig,

  // Room types
  RoomConfig,
  RoomInfo,
  RoomStatus,

  // Participant types
  Participant,
  ParticipantRole,

  // Media types
  Track,
  TrackKind,
  MediaDevice,
  MediaDeviceKind,
  MediaDeviceInfo, // deprecated alias
  MediaConstraints,

  // Chat types
  ChatMessage,

  // Recording types
  Recording,
  RecordingStatus,

  // Event types
  ChalkEventType,
  ChalkError,

  // Screen share
  ScreenShareOptions,

  // Reactions
  Reaction,
  ReactionEmoji,

  // API types
  ApiResponse,
  CreateRoomResponse,
  JoinRoomResponse,
} from './types.ts';

// Export error code constants
export { ChalkErrorCode, ok, err } from './types.ts';

// Event emitter (for advanced use cases)
export { EventEmitter } from './events.ts';
