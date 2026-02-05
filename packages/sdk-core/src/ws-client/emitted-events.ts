import type {
	ChalkError,
	ChatMessage,
	Participant,
	Reaction,
	RoomSnapshot,
} from "../types.ts";

const wsEventPayloads = {
	connected: undefined as void,
	disconnected: null as unknown as { reason?: string },
	reconnecting: null as unknown as { attempt: number },
	error: null as unknown as ChalkError,
	"token-expired": null as unknown as ChalkError,
	registered: null as unknown as {
		participantId: string;
		roomId: string;
		tenantId: string;
	},
	"participant.joined": null as unknown as Participant,
	"participant.left": null as unknown as { participantId: string },
	"participant.updated": null as unknown as {
		participantId: string;
		changes: Partial<Participant>;
	},
	"participant.mute": null as unknown as { participantId: string; requestedBy?: string },
	"participant.unmute": null as unknown as { participantId: string; requestedBy?: string },
	"chat.message": null as unknown as ChatMessage,
	reaction: null as unknown as Reaction,
	"hand.raised": null as unknown as { participantId: string },
	"hand.lowered": null as unknown as { participantId: string },
	"recording.started": null as unknown as { recordingId: string },
	"recording.stopped": null as unknown as { recordingId: string; duration: number },
	"room.updated": null as unknown as { roomId: string; changes: Record<string, unknown> },
	"room.snapshot": null as unknown as RoomSnapshot,
	"room.sync": null as unknown as RoomSnapshot,
	"whiteboard.data": null as unknown as {
		participantId: string;
		displayName: string;
		elements: unknown[];
		files?: Record<string, unknown>;
		seq: number;
		timestamp: Date;
	},
	"whiteboard.snapshot": null as unknown as {
		roomId: string;
		elements: unknown[];
		files: Record<string, unknown>;
		appState: Record<string, unknown>;
		lastSeq: number;
	},
	"whiteboard.cursor": null as unknown as {
		participantId: string;
		displayName: string;
		x: number;
		y: number;
		timestamp: Date;
	},
	"permission.changed": null as unknown as {
		participantId: string;
		feature: string;
		canDraw: boolean;
		grantedBy: string;
		timestamp: Date;
	},
	"whiteboard.opened": null as unknown as {
		participantId: string;
		displayName: string;
		timestamp: Date;
	},
	"whiteboard.closed": null as unknown as {
		participantId: string;
		timestamp: Date;
	},
} as const;

export type WSEvents = {
	[K in keyof typeof wsEventPayloads]: (typeof wsEventPayloads)[K];
};
