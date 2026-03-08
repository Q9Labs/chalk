import type { WSEvents } from "./emitted-events.ts";
import type {
	WSInboundPayloadMap,
	WSInboundType,
	WSOutboundMessage,
} from "./messages.ts";
import {
	toChatMessage,
	toParticipant,
	toPermissionChanged,
	toReaction,
	toSnapshot,
	toWhiteboardClosed,
	toWhiteboardCursor,
	toWhiteboardData,
	toWhiteboardOpened,
	toWhiteboardSnapshot,
	unwrapParticipantJoined,
} from "./transforms.ts";

type Emit = <K extends keyof WSEvents>(event: K, data: WSEvents[K]) => void;

export const createInboundHandlers = (deps: {
	emit: Emit;
	send: (message: WSOutboundMessage) => void;
	now: () => number;
	setLastPongTime: (ts: number) => void;
}) =>
	({
		"participant.joined": (payload) => {
			deps.emit(
				"participant.joined",
				toParticipant(unwrapParticipantJoined(payload)),
			);
		},
		"participant.left": (payload) => {
			deps.emit("participant.left", { participantId: payload.participantId });
		},
		"participant.updated": (payload) => {
			deps.emit("participant.updated", {
				participantId: payload.participantId,
				changes: payload.changes,
			});
		},
		"participant.mute": (payload) => {
			deps.emit("participant.mute", payload);
		},
		"participant.unmute": (payload) => {
			deps.emit("participant.unmute", payload);
		},
		"chat.message": (payload) => {
			deps.emit("chat.message", toChatMessage(payload));
		},
		"chat.read": (payload) => {
			deps.emit("chat.read", {
				messageIds: payload.messageIds as string[],
				participantId: payload.participantId,
				displayName: payload.displayName,
				readAt: new Date(payload.readAt),
			});
		},
		reaction: (payload) => {
			deps.emit("reaction", toReaction(payload));
		},
		"hand.raised": (payload) => {
			deps.emit("hand.raised", { participantId: payload.participantId });
		},
		"hand.lowered": (payload) => {
			deps.emit("hand.lowered", { participantId: payload.participantId });
		},
		"recording.started": (payload) => {
			deps.emit("recording.started", { recordingId: payload.recordingId });
		},
		"recording.stopped": (payload) => {
			deps.emit("recording.stopped", payload);
		},
		"room.updated": (payload) => {
			deps.emit("room.updated", payload);
		},
		"room.snapshot": (payload) => {
			deps.emit("room.snapshot", toSnapshot(payload));
		},
		"room.sync": (payload) => {
			deps.emit("room.sync", toSnapshot(payload));
		},
		connected: (payload) => {
			deps.emit("registered", payload);
		},
		error: (payload) => {
			deps.emit("error", payload);
		},
		"whiteboard.data": (payload) => {
			deps.emit("whiteboard.data", toWhiteboardData(payload));
		},
		"whiteboard.snapshot": (payload) => {
			deps.emit("whiteboard.snapshot", toWhiteboardSnapshot(payload));
		},
		"whiteboard.cursor": (payload) => {
			deps.emit("whiteboard.cursor", toWhiteboardCursor(payload));
		},
		"permission.changed": (payload) => {
			deps.emit("permission.changed", toPermissionChanged(payload));
		},
		"whiteboard.opened": (payload) => {
			deps.emit("whiteboard.opened", toWhiteboardOpened(payload));
		},
		"whiteboard.closed": (payload) => {
			deps.emit("whiteboard.closed", toWhiteboardClosed(payload));
		},
		ping: (_payload) => {
			deps.send({ type: "pong" });
		},
		pong: (_payload) => {
			deps.setLastPongTime(deps.now());
		},
		"transcript.ack": (_payload) => {
			// Acknowledged, no action needed
		},
	}) satisfies Partial<{
		[K in WSInboundType]: (payload: WSInboundPayloadMap[K]) => void;
	}>;
