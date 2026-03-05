/**
 * @effect/schema definitions for WSClient-emitted events
 *
 * Single source of truth for event payload shapes (type inferred from schema).
 *
 * @packageDocumentation
 * @module @q9labs/chalk-core/effect/schemas
 */

import { Schema } from "@effect/schema";

import type {
	ChalkError,
	ChatMessage,
	Participant,
	Reaction,
	SessionSnapshot,
} from "../../types.ts";
import type {
	WhiteboardCursor,
	WhiteboardPermission,
	WhiteboardSnapshot,
	WhiteboardUpdate,
} from "../../types/entities/whiteboard.ts";
import { RegisteredPayload } from "./ws-events.ts";

const isObject = (input: unknown): input is Record<string, unknown> =>
	typeof input === "object" && input !== null && !Array.isArray(input);

const ChalkErrorSchema = Schema.declare(
	(input): input is ChalkError => isObject(input),
);

const ParticipantSchema = Schema.declare(
	(input): input is Participant => isObject(input),
);

const ParticipantChangesSchema = Schema.declare(
	(input): input is Partial<Participant> => isObject(input),
);

const ChatMessageSchema = Schema.declare(
	(input): input is ChatMessage => isObject(input),
);

const ReactionSchema = Schema.declare(
	(input): input is Reaction => isObject(input),
);

const RoomSnapshotSchema = Schema.declare(
	(input): input is SessionSnapshot => isObject(input),
);

const WhiteboardUpdateSchema = Schema.declare(
	(input): input is WhiteboardUpdate => isObject(input),
);

const WhiteboardSnapshotSchema = Schema.declare(
	(input): input is WhiteboardSnapshot => isObject(input),
);

const WhiteboardCursorSchema = Schema.declare(
	(input): input is WhiteboardCursor => isObject(input),
);

const WhiteboardPermissionSchema = Schema.declare(
	(input): input is WhiteboardPermission => isObject(input),
);

export const WSEventSchemas = {
	connected: Schema.Void,
	disconnected: Schema.Struct({ reason: Schema.optional(Schema.String) }),
	reconnecting: Schema.Struct({ attempt: Schema.Number }),
	error: ChalkErrorSchema,
	"token-expired": ChalkErrorSchema,
	registered: RegisteredPayload,
	"participant.joined": ParticipantSchema,
	"participant.left": Schema.Struct({ participantId: Schema.String }),
	"participant.updated": Schema.Struct({
		participantId: Schema.String,
		changes: ParticipantChangesSchema,
	}),
	"participant.mute": Schema.Struct({
		participantId: Schema.String,
		requestedBy: Schema.optional(Schema.String),
	}),
	"participant.unmute": Schema.Struct({
		participantId: Schema.String,
		requestedBy: Schema.optional(Schema.String),
	}),
	"chat.message": ChatMessageSchema,
	reaction: ReactionSchema,
	"hand.raised": Schema.Struct({ participantId: Schema.String }),
	"hand.lowered": Schema.Struct({ participantId: Schema.String }),
	"recording.started": Schema.Struct({ recordingId: Schema.String }),
	"recording.stopped": Schema.Struct({
		recordingId: Schema.String,
		duration: Schema.Number,
	}),
	"room.updated": Schema.Struct({
		roomId: Schema.String,
		changes: Schema.Record({ key: Schema.String, value: Schema.Unknown }),
	}),
	"room.snapshot": RoomSnapshotSchema,
	"room.sync": RoomSnapshotSchema,
	"whiteboard.data": WhiteboardUpdateSchema,
	"whiteboard.snapshot": WhiteboardSnapshotSchema,
	"whiteboard.cursor": WhiteboardCursorSchema,
	"permission.changed": WhiteboardPermissionSchema,
	"whiteboard.opened": Schema.Struct({
		participantId: Schema.String,
		displayName: Schema.String,
		timestamp: Schema.DateFromSelf,
	}),
	"whiteboard.closed": Schema.Struct({
		participantId: Schema.String,
		timestamp: Schema.DateFromSelf,
	}),
} as const;
