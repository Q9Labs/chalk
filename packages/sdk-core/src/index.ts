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
export { ChalkClient } from "./client.ts";
// Event emitter (for advanced use cases)
export { EventEmitter } from "./events.ts";
// Room
export { Room } from "./room.ts";
// Types
export type {
	// API types
	ApiResponse,
	// Client config
	ChalkClientConfig,
	ChalkError,
	// Event types
	ChalkEventType,
	// Chat types
	ChatMessage,
	CreateRoomResponse,
	Err,
	JoinRoomResponse,
	MediaConstraints,
	MediaDevice,
	MediaDeviceInfo, // deprecated alias
	MediaDeviceKind,
	Ok,
	// Participant types
	Participant,
	ParticipantRole,
	// Reactions
	Reaction,
	ReactionEmoji,
	// Recording types
	Recording,
	RecordingStatus,
	// Result types for error handling
	Result,
	// Room types
	RoomConfig,
	RoomInfo,
	RoomStatus,
	// Screen share
	ScreenShareOptions,
	// Media types
	Track,
	TrackKind,
} from "./types.ts";
// Export error code constants
export { ChalkErrorCode, err, ok } from "./types.ts";
