/**
 * Event type exports for Chalk SDK
 *
 * @packageDocumentation
 * @module @q9labs/chalk-core/types/events
 */

// Server events (Server → Client)
export type {
  ServerEventMap,
  ServerEventName,
  ConnectedPayload,
  ServerParticipant,
  ParticipantJoinedPayload,
  ParticipantLeftPayload,
  ParticipantUpdatedPayload,
  ChatMessagePayload,
  ReactionPayload,
  HandRaisedPayload,
  HandLoweredPayload,
  ServerRoom,
  RoomUpdatedPayload,
  RoomSnapshotPayload,
  RecordingStartedPayload,
  RecordingStoppedPayload,
  ErrorPayload,
  PingPayload,
  WhiteboardDataPayload,
  WhiteboardSnapshotPayload,
  WhiteboardCursorPayload,
  WhiteboardOpenedPayload,
  WhiteboardClosedPayload,
  PermissionChangedPayload,
} from "./server-events";

// Client events (Client → Server)
export type {
  ClientEventMap,
  ClientEventName,
  ChatSendPayload,
  ReactionSendPayload,
  RoomSyncPayload,
  PongPayload,
  WhiteboardUpdatePayload,
  WhiteboardCursorSendPayload,
  PermissionGrantPayload,
  PermissionRevokePayload,
  WsMessage,
} from "./client-events";

// Message type maps for wire protocol
export { serverMessageTypeMap, clientMessageTypeMap } from "./client-events";
