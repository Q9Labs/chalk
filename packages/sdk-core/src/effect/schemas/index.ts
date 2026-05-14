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
  // Heartbeat
  HeartbeatPayload,
  // Participant schemas
  ParticipantPayload,
  ParticipantJoinedPayload,
  ParticipantLeftPayload,
  ParticipantUpdatedPayload,
  ParticipantControlPayload,
  // Chat schemas
  ChatMessagePayload,
  // Reaction schemas
  ReactionPayload,
  // Hand schemas
  HandPayload,
  // Recording schemas
  RecordingStartedPayload,
  RecordingStoppedPayload,
  // ConferenceSession schemas
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
  // Transcript
  TranscriptAckPayload,
  // Schema map
  WSPayloadSchemas,
  type WSMessageType as WSMessageTypeName,
} from "./ws-events";

// Whiteboard schemas
export { AppStateSchema, AppStatePartialSchema } from "./whiteboard";

// WSClient emitted event schemas
export { WSEventSchemas } from "./ws-emitted";

// WebSocket outbound schemas
export { WSOutboundPayloadSchemas, type WSOutboundMessageType } from "./ws-outbound";

// API response schemas
export {
  // Error schema
  ApiErrorSchema,
  type ApiError,
  // Response wrapper
  ApiResponse,
  // ConferenceSession schemas
  RoomInfoSchema,
  type SessionInfo,
  TokenSetSchema,
  type TokenSet,
  CreateRoomResponseSchema,
  type CreateRoomResponse,
  JoinRoomResponseSchema,
  type JoinSessionResponse,
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
  type SessionConnectionState,
  // Decode helpers
  decode,
  decodeEffect,
  encode,
} from "./api";

// Manager state schemas
export {
  // ConferenceSession state
  RoomStatusSchema as RoomManagerStatusSchema,
  RoomStateSchema,
  RoomEventSchema,
  type SessionConnectionState as RoomManagerStatus,
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
