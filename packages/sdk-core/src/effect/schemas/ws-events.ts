/**
 * @effect/schema definitions for WebSocket message payloads
 *
 * Provides runtime validation for all WS messages between client and server.
 * Replaces type assertions with proper validation.
 *
 * @packageDocumentation
 * @module @q9labs/chalk-core/effect/schemas
 */

import { Schema } from "@effect/schema";
import { AppStateSchema } from "./whiteboard";

/**
 * WebSocket message envelope
 */
export const WSMessage = Schema.Struct({
  type: Schema.String,
  payload: Schema.optional(Schema.Unknown),
});
export type WSMessage = Schema.Schema.Type<typeof WSMessage>;

/**
 * ping / pong heartbeat payload
 *
 * Server typically includes a timestamp, but accept `void` for compatibility.
 */
export const HeartbeatPayload = Schema.Union(
  Schema.Void,
  Schema.Struct({
    timestamp: Schema.optional(Schema.Union(Schema.String, Schema.DateFromSelf)),
  }),
);
export type HeartbeatPayload = Schema.Schema.Type<typeof HeartbeatPayload>;

/**
 * Participant schema (embedded in various events)
 */
export const ParticipantPayload = Schema.Struct({
  id: Schema.String,
  roomId: Schema.optional(Schema.String),
  displayName: Schema.String,
  isActive: Schema.optional(Schema.Boolean),
  joinedAt: Schema.optional(Schema.Union(Schema.String, Schema.DateFromSelf)),
  role: Schema.optional(Schema.Union(Schema.Literal("host"), Schema.Literal("participant"))),
  isLocal: Schema.optional(Schema.Boolean),
  videoEnabled: Schema.optional(Schema.Boolean),
  audioEnabled: Schema.optional(Schema.Boolean),
  isSpeaking: Schema.optional(Schema.Boolean),
  isScreenSharing: Schema.optional(Schema.Boolean),
  handRaised: Schema.optional(Schema.Boolean),
  connectionQuality: Schema.optional(Schema.Number),
  metadata: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.Unknown })),
});
export type ParticipantPayload = Schema.Schema.Type<typeof ParticipantPayload>;

/**
 * participant.joined event payload
 */
export const ParticipantJoinedPayload = Schema.Union(
  // Nested format: { participant: {...} }
  Schema.Struct({
    participant: ParticipantPayload,
  }),
  // Flat format: {...participant fields}
  ParticipantPayload,
);
export type ParticipantJoinedPayload = Schema.Schema.Type<typeof ParticipantJoinedPayload>;

/**
 * participant.left event payload
 */
export const ParticipantLeftPayload = Schema.Struct({
  participantId: Schema.String,
});
export type ParticipantLeftPayload = Schema.Schema.Type<typeof ParticipantLeftPayload>;

/**
 * participant.updated event payload
 */
export const ParticipantUpdatedPayload = Schema.Struct({
  participantId: Schema.String,
  changes: Schema.Struct({
    displayName: Schema.optional(Schema.String),
    videoEnabled: Schema.optional(Schema.Boolean),
    audioEnabled: Schema.optional(Schema.Boolean),
    isSpeaking: Schema.optional(Schema.Boolean),
    isScreenSharing: Schema.optional(Schema.Boolean),
    handRaised: Schema.optional(Schema.Boolean),
    connectionQuality: Schema.optional(Schema.Number),
  }),
});
export type ParticipantUpdatedPayload = Schema.Schema.Type<typeof ParticipantUpdatedPayload>;

/**
 * participant.mute / participant.unmute command payload
 */
export const ParticipantControlPayload = Schema.Struct({
  participantId: Schema.String,
  requestedBy: Schema.optional(Schema.String),
});
export type ParticipantControlPayload = Schema.Schema.Type<typeof ParticipantControlPayload>;

/**
 * chat.message event payload
 */
export const ChatMessagePayload = Schema.Struct({
  id: Schema.String,
  participantId: Schema.String,
  displayName: Schema.String,
  content: Schema.String,
  timestamp: Schema.String,
  attachments: Schema.optional(
    Schema.Array(
      Schema.Struct({
        id: Schema.String,
        fileName: Schema.String,
        mimeType: Schema.String,
        sizeBytes: Schema.Number,
        kind: Schema.Union(Schema.Literal("image"), Schema.Literal("document"), Schema.Literal("file")),
      }),
    ),
  ),
  readBy: Schema.optional(
    Schema.Array(
      Schema.Struct({
        participantId: Schema.String,
        displayName: Schema.String,
        readAt: Schema.String,
      }),
    ),
  ),
});
export type ChatMessagePayload = Schema.Schema.Type<typeof ChatMessagePayload>;

export const ChatReadPayload = Schema.Struct({
  messageIds: Schema.Array(Schema.String),
  participantId: Schema.String,
  displayName: Schema.String,
  readAt: Schema.String,
});
export type ChatReadPayload = Schema.Schema.Type<typeof ChatReadPayload>;

/**
 * reaction event payload
 */
export const ReactionPayload = Schema.Struct({
  participantId: Schema.String,
  participantName: Schema.optional(Schema.String),
  emoji: Schema.String,
  timestamp: Schema.Union(Schema.String, Schema.DateFromSelf),
});
export type ReactionPayload = Schema.Schema.Type<typeof ReactionPayload>;

/**
 * hand.raised / hand.lowered event payload
 */
export const HandPayload = Schema.Struct({
  participantId: Schema.String,
});
export type HandPayload = Schema.Schema.Type<typeof HandPayload>;

/**
 * recording.started event payload
 */
export const RecordingStartedPayload = Schema.Struct({
  recordingId: Schema.String,
});
export type RecordingStartedPayload = Schema.Schema.Type<typeof RecordingStartedPayload>;

/**
 * recording.stopped event payload
 */
export const RecordingStoppedPayload = Schema.Struct({
  recordingId: Schema.String,
  duration: Schema.Number,
});
export type RecordingStoppedPayload = Schema.Schema.Type<typeof RecordingStoppedPayload>;

/**
 * room.updated event payload
 */
export const RoomUpdatedPayload = Schema.Struct({
  roomId: Schema.String,
  changes: Schema.Record({ key: Schema.String, value: Schema.Unknown }),
});
export type RoomUpdatedPayload = Schema.Schema.Type<typeof RoomUpdatedPayload>;

/**
 * room.snapshot / room.sync event payload
 */
export const RoomSnapshotPayload = Schema.Struct({
  roomId: Schema.String,
  participants: Schema.Array(ParticipantPayload),
  isRecording: Schema.Boolean,
  recordingId: Schema.optional(Schema.String),
  lastSeq: Schema.Number,
  messages: Schema.optional(Schema.Array(ChatMessagePayload)),
});
export type RoomSnapshotPayload = Schema.Schema.Type<typeof RoomSnapshotPayload>;

/**
 * connected event payload (registration confirmation)
 */
export const RegisteredPayload = Schema.Struct({
  participantId: Schema.String,
  roomId: Schema.String,
  tenantId: Schema.String,
});
export type RegisteredPayload = Schema.Schema.Type<typeof RegisteredPayload>;

/**
 * whiteboard.data event payload
 */
export const WhiteboardDataPayload = Schema.Struct({
  schemaVersion: Schema.Literal(2),
  sceneId: Schema.String,
  syncAll: Schema.Boolean,
  participantId: Schema.String,
  displayName: Schema.String,
  elements: Schema.Array(Schema.Unknown),
  files: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.Unknown })),
  seq: Schema.Number,
  timestamp: Schema.Union(Schema.String, Schema.DateFromSelf),
});
export type WhiteboardDataPayload = Schema.Schema.Type<typeof WhiteboardDataPayload>;

/**
 * whiteboard.snapshot event payload
 */
export const WhiteboardSnapshotPayload = Schema.Struct({
  schemaVersion: Schema.Literal(2),
  roomId: Schema.String,
  sceneId: Schema.String,
  elements: Schema.Array(Schema.Unknown),
  files: Schema.Record({ key: Schema.String, value: Schema.Unknown }),
  appState: AppStateSchema,
  updatedAtMs: Schema.optional(Schema.Number),
  lastSeq: Schema.Number,
});
export type WhiteboardSnapshotPayload = Schema.Schema.Type<typeof WhiteboardSnapshotPayload>;

/**
 * whiteboard.cursor event payload
 */
export const WhiteboardCursorPayload = Schema.Struct({
  participantId: Schema.String,
  displayName: Schema.String,
  x: Schema.Number,
  y: Schema.Number,
  timestamp: Schema.Union(Schema.String, Schema.DateFromSelf),
});
export type WhiteboardCursorPayload = Schema.Schema.Type<typeof WhiteboardCursorPayload>;

/**
 * permission.changed event payload
 */
export const PermissionChangedPayload = Schema.Struct({
  participantId: Schema.String,
  feature: Schema.Union(Schema.Literal("whiteboard"), Schema.Literal("annotations")),
  canDraw: Schema.Boolean,
  grantedBy: Schema.String,
  timestamp: Schema.Union(Schema.String, Schema.DateFromSelf),
});
export type PermissionChangedPayload = Schema.Schema.Type<typeof PermissionChangedPayload>;

/**
 * whiteboard.opened event payload
 */
export const WhiteboardOpenedPayload = Schema.Struct({
  participantId: Schema.String,
  displayName: Schema.String,
  timestamp: Schema.Union(Schema.String, Schema.DateFromSelf),
});
export type WhiteboardOpenedPayload = Schema.Schema.Type<typeof WhiteboardOpenedPayload>;

/**
 * whiteboard.closed event payload
 */
export const WhiteboardClosedPayload = Schema.Struct({
  participantId: Schema.String,
  timestamp: Schema.Union(Schema.String, Schema.DateFromSelf),
});
export type WhiteboardClosedPayload = Schema.Schema.Type<typeof WhiteboardClosedPayload>;

export const AnnotationSessionStartedPayload = Schema.Struct({
  shareSessionId: Schema.String,
  sharerParticipantId: Schema.String,
  accessMode: Schema.Union(Schema.Literal("all"), Schema.Literal("sharer_only"), Schema.Literal("off")),
  timestamp: Schema.Union(Schema.String, Schema.DateFromSelf),
});
export type AnnotationSessionStartedPayload = Schema.Schema.Type<typeof AnnotationSessionStartedPayload>;

export const AnnotationSessionEndedPayload = Schema.Struct({
  shareSessionId: Schema.String,
  timestamp: Schema.Union(Schema.String, Schema.DateFromSelf),
});
export type AnnotationSessionEndedPayload = Schema.Schema.Type<typeof AnnotationSessionEndedPayload>;

export const AnnotationSnapshotPayload = Schema.Struct({
  roomId: Schema.String,
  shareSessionId: Schema.String,
  sharerParticipantId: Schema.String,
  accessMode: Schema.Union(Schema.Literal("all"), Schema.Literal("sharer_only"), Schema.Literal("off")),
  items: Schema.Array(Schema.Unknown),
  updatedAtMs: Schema.optional(Schema.Number),
  lastSeq: Schema.Number,
});
export type AnnotationSnapshotPayload = Schema.Schema.Type<typeof AnnotationSnapshotPayload>;

export const AnnotationDataPayload = Schema.Struct({
  shareSessionId: Schema.String,
  sharerParticipantId: Schema.String,
  participantId: Schema.String,
  displayName: Schema.String,
  syncAll: Schema.Boolean,
  items: Schema.Array(Schema.Unknown),
  seq: Schema.Number,
  timestamp: Schema.Union(Schema.String, Schema.DateFromSelf),
});
export type AnnotationDataPayload = Schema.Schema.Type<typeof AnnotationDataPayload>;

export const AnnotationCursorPayload = Schema.Struct({
  shareSessionId: Schema.String,
  participantId: Schema.String,
  displayName: Schema.String,
  tool: Schema.Union(Schema.Literal("pen"), Schema.Literal("highlighter"), Schema.Literal("rectangle"), Schema.Literal("ellipse"), Schema.Literal("line"), Schema.Literal("arrow"), Schema.Literal("text")),
  x: Schema.Number,
  y: Schema.Number,
  timestamp: Schema.Union(Schema.String, Schema.DateFromSelf),
});
export type AnnotationCursorPayload = Schema.Schema.Type<typeof AnnotationCursorPayload>;

export const AnnotationAccessChangedPayload = Schema.Struct({
  shareSessionId: Schema.String,
  accessMode: Schema.Union(Schema.Literal("all"), Schema.Literal("sharer_only"), Schema.Literal("off")),
  changedBy: Schema.String,
  timestamp: Schema.Union(Schema.String, Schema.DateFromSelf),
});
export type AnnotationAccessChangedPayload = Schema.Schema.Type<typeof AnnotationAccessChangedPayload>;

/**
 * error event payload
 */
export const ErrorPayload = Schema.Struct({
  code: Schema.String,
  message: Schema.String,
  details: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.Unknown })),
});
export type ErrorPayload = Schema.Schema.Type<typeof ErrorPayload>;

/**
 * transcript.ack payload
 */
export const TranscriptAckPayload = Schema.Union(
  Schema.Void,
  Schema.Struct({
    id: Schema.String,
    timestamp: Schema.Union(Schema.String, Schema.DateFromSelf),
  }),
);
export type TranscriptAckPayload = Schema.Schema.Type<typeof TranscriptAckPayload>;

/**
 * Map of message type to payload schema
 */
export const WSPayloadSchemas = {
  "participant.joined": ParticipantJoinedPayload,
  "participant.left": ParticipantLeftPayload,
  "participant.updated": ParticipantUpdatedPayload,
  "participant.mute": ParticipantControlPayload,
  "participant.unmute": ParticipantControlPayload,
  "chat.message": ChatMessagePayload,
  "chat.read": ChatReadPayload,
  reaction: ReactionPayload,
  "hand.raised": HandPayload,
  "hand.lowered": HandPayload,
  "recording.started": RecordingStartedPayload,
  "recording.stopped": RecordingStoppedPayload,
  "room.updated": RoomUpdatedPayload,
  "room.snapshot": RoomSnapshotPayload,
  "room.sync": RoomSnapshotPayload,
  connected: RegisteredPayload,
  "whiteboard.data": WhiteboardDataPayload,
  "whiteboard.snapshot": WhiteboardSnapshotPayload,
  "whiteboard.cursor": WhiteboardCursorPayload,
  "permission.changed": PermissionChangedPayload,
  "whiteboard.opened": WhiteboardOpenedPayload,
  "whiteboard.closed": WhiteboardClosedPayload,
  "annotation.session.started": AnnotationSessionStartedPayload,
  "annotation.session.ended": AnnotationSessionEndedPayload,
  "annotation.snapshot": AnnotationSnapshotPayload,
  "annotation.data": AnnotationDataPayload,
  "annotation.cursor": AnnotationCursorPayload,
  "annotation.access.changed": AnnotationAccessChangedPayload,
  ping: HeartbeatPayload,
  pong: HeartbeatPayload,
  "transcript.ack": TranscriptAckPayload,
  error: ErrorPayload,
} as const;

export type WSMessageType = keyof typeof WSPayloadSchemas;
