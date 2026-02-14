/**
 * @effect/schema definitions for WebSocket outbound message payloads
 *
 * Client → Server messages sent by WSClient.
 *
 * @packageDocumentation
 * @module @q9labs/chalk-core/effect/schemas
 */

import { Schema } from "@effect/schema";
import { AppStatePartialSchema } from "./whiteboard";

/**
 * chat.send payload
 */
export const ChatSendPayload = Schema.Struct({
  content: Schema.String,
});
export type ChatSendPayload = Schema.Schema.Type<typeof ChatSendPayload>;

/**
 * reaction.send payload
 */
export const ReactionSendPayload = Schema.Struct({
  emoji: Schema.String,
});
export type ReactionSendPayload = Schema.Schema.Type<typeof ReactionSendPayload>;

/**
 * participant.mute / participant.unmute payload
 */
export const ParticipantControlPayload = Schema.Struct({
  participantId: Schema.String,
  requestedBy: Schema.optional(Schema.String),
});
export type ParticipantControlPayload = Schema.Schema.Type<typeof ParticipantControlPayload>;

/**
 * whiteboard.update payload
 */
export const WhiteboardUpdateV1Payload = Schema.Struct({
  elements: Schema.Array(Schema.Unknown),
  files: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.Unknown })),
  appState: Schema.optional(AppStatePartialSchema),
  seq: Schema.Number,
});

export const WhiteboardUpdateV2Payload = Schema.Struct({
  schemaVersion: Schema.Literal(2),
  sceneId: Schema.String,
  syncAll: Schema.Boolean,
  elements: Schema.Array(Schema.Unknown),
  seq: Schema.Number,
});

export const WhiteboardUpdatePayload = Schema.Union(
  WhiteboardUpdateV1Payload,
  WhiteboardUpdateV2Payload,
);
export type WhiteboardUpdatePayload = Schema.Schema.Type<typeof WhiteboardUpdatePayload>;

/**
 * whiteboard.cursor payload
 */
export const WhiteboardCursorPayload = Schema.Struct({
  x: Schema.Number,
  y: Schema.Number,
});
export type WhiteboardCursorPayload = Schema.Schema.Type<typeof WhiteboardCursorPayload>;

/**
 * permission.grant / permission.revoke payload
 */
export const PermissionPayload = Schema.Struct({
  participantId: Schema.String,
  feature: Schema.Union(Schema.Literal("whiteboard"), Schema.Literal("annotations")),
});
export type PermissionPayload = Schema.Schema.Type<typeof PermissionPayload>;

/**
 * transcript payload
 *
 * NOTE: Wire format expects camelCase keys (participantId, speakerName, isInterim).
 */
export const TranscriptPayload = Schema.Struct({
  id: Schema.String,
  participantId: Schema.String,
  speakerName: Schema.String,
  text: Schema.String,
  timestamp: Schema.String,
  isInterim: Schema.optional(Schema.Boolean),
  confidence: Schema.optional(Schema.Number),
});
export type TranscriptPayload = Schema.Schema.Type<typeof TranscriptPayload>;

/**
 * room.sync payload
 */
export const RoomSyncPayload = Schema.Struct({
  lastSeq: Schema.Number,
});
export type RoomSyncPayload = Schema.Schema.Type<typeof RoomSyncPayload>;

/**
 * Map of outbound message type → payload schema
 */
export const WSOutboundPayloadSchemas = {
  "room.sync": RoomSyncPayload,
  "chat.send": ChatSendPayload,
  "reaction.send": ReactionSendPayload,
  "hand.raise": Schema.Void,
  "hand.lower": Schema.Void,
  "participant.mute": ParticipantControlPayload,
  "participant.unmute": ParticipantControlPayload,
  "whiteboard.update": WhiteboardUpdatePayload,
  "whiteboard.sync": Schema.Void,
  "whiteboard.clear": Schema.Void,
  "whiteboard.cursor": WhiteboardCursorPayload,
  "whiteboard.open": Schema.Void,
  "whiteboard.close": Schema.Void,
  "permission.grant": PermissionPayload,
  "permission.revoke": PermissionPayload,
  transcript: TranscriptPayload,
  ping: Schema.Void,
  pong: Schema.Void,
} as const;

export type WSOutboundMessageType = keyof typeof WSOutboundPayloadSchemas;
