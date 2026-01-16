/**
 * Schema exports for Chalk SDK
 *
 * @packageDocumentation
 * @module @q9labs/chalk-core/effect/schemas
 */

// WebSocket event schemas
export {
  // Message envelope
  WSMessage,
  type WSMessage as WSMessageType,
  // Participant schemas
  ParticipantPayload,
  ParticipantJoinedPayload,
  ParticipantLeftPayload,
  ParticipantUpdatedPayload,
  // Chat schemas
  ChatMessagePayload,
  // Reaction schemas
  ReactionPayload,
  // Hand schemas
  HandPayload,
  // Recording schemas
  RecordingStartedPayload,
  RecordingStoppedPayload,
  // Room schemas
  RoomUpdatedPayload,
  RoomSnapshotPayload,
  RegisteredPayload,
  // Whiteboard schemas
  WhiteboardDataPayload,
  WhiteboardSnapshotPayload,
  WhiteboardCursorPayload,
  PermissionChangedPayload,
  WhiteboardOpenedPayload,
  WhiteboardClosedPayload,
  // Error schema
  ErrorPayload,
  // Schema map
  WSPayloadSchemas,
  type WSMessageType as WSMessageTypeName,
} from "./ws-events";

// API response schemas
export {
  // Error schema
  ApiErrorSchema,
  type ApiError,
  // Response wrapper
  ApiResponse,
  // Room schemas
  RoomInfoSchema,
  type RoomInfo,
  TokenSetSchema,
  type TokenSet,
  CreateRoomResponseSchema,
  type CreateRoomResponse,
  JoinRoomResponseSchema,
  type JoinRoomResponse,
  RawJoinRoomResponseSchema,
  type RawJoinRoomResponse,
  // Recording schemas
  RecordingSchema,
  type Recording,
  StartRecordingResponseSchema,
  type StartRecordingResponse,
  DownloadUrlResponseSchema,
  type DownloadUrlResponse,
  // Common schemas
  ParticipantRoleSchema,
  type ParticipantRole,
  RoomStatusSchema,
  type RoomStatus,
  // Decode helpers
  decode,
  decodeEffect,
  encode,
} from "./api";

// Manager state schemas
export {
  // Room state
  RoomStatusSchema as RoomManagerStatusSchema,
  RoomStateSchema,
  RoomEventSchema,
  type RoomStatus as RoomManagerStatus,
  type RoomState,
  type RoomEvent,
  // Participant state
  ParticipantSchema,
  ParticipantStateSchema,
  ParticipantEventSchema,
  type ParticipantData,
  type ParticipantState,
  type ParticipantEvent,
  // Media state
  MediaDeviceSchema,
  MediaStateSchema,
  MediaEventSchema,
  type MediaDeviceData,
  type MediaState,
  type MediaEvent,
} from "./manager-state";
