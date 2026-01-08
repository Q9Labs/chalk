/**
 * Client → Server WebSocket event types for Chalk SDK
 *
 * These events are sent from the client to the Go backend.
 * Maps directly to MessageType constants in messages.go.
 *
 * @packageDocumentation
 * @module @q9labs/chalk-core/types
 */

// ============================================================================
// Payload Types (matching Go structs in messages.go)
// ============================================================================

/** Send a chat message */
export interface ChatSendPayload {
	content: string;
}

/** Send an emoji reaction */
export interface ReactionSendPayload {
	emoji: string;
}

/** Request room state sync */
export interface RoomSyncPayload {
	lastSeq: number;
}

/** Pong response to server ping */
export interface PongPayload {
	timestamp: string;
}

/** Send whiteboard update */
export interface WhiteboardUpdatePayload {
	elements: unknown[];
	files?: Record<string, unknown>;
	appState?: Record<string, unknown>;
	seq: number;
}

/** Send cursor position on whiteboard */
export interface WhiteboardCursorSendPayload {
	x: number;
	y: number;
}

/** Grant permission to a participant */
export interface PermissionGrantPayload {
	participantId: string;
	feature: "whiteboard" | "annotations";
}

/** Revoke permission from a participant */
export interface PermissionRevokePayload {
	participantId: string;
	feature: "whiteboard" | "annotations";
}

// ============================================================================
// Client Event Map
// ============================================================================

/**
 * Map of all client → server WebSocket events.
 *
 * Event names use imperative form since they're commands/requests.
 * Format: `domain:action` (e.g., `chat:send`, `hand:raise`)
 *
 * @example
 * ```ts
 * // Type-safe event sending
 * wsClient.send('chat:send', { content: 'Hello!' });
 * wsClient.send('hand:raise', {}); // Empty payload
 * ```
 */
export interface ClientEventMap {
	// Chat events
	"chat:send": ChatSendPayload;

	// Interaction events
	"reaction:send": ReactionSendPayload;
	"hand:raise": Record<string, never>; // Empty payload
	"hand:lower": Record<string, never>;

	// Room events
	"room:sync": RoomSyncPayload;

	// Whiteboard events
	"whiteboard:update": WhiteboardUpdatePayload;
	"whiteboard:sync": Record<string, never>;
	"whiteboard:clear": Record<string, never>;
	"whiteboard:cursor": WhiteboardCursorSendPayload;
	"whiteboard:open": Record<string, never>;
	"whiteboard:close": Record<string, never>;

	// Permission events
	"permission:grant": PermissionGrantPayload;
	"permission:revoke": PermissionRevokePayload;

	// Heartbeat
	pong: PongPayload;
}

/**
 * All client event names as a union type
 */
export type ClientEventName = keyof ClientEventMap;

// ============================================================================
// Message Wire Format
// ============================================================================

/**
 * WebSocket message structure (matches Go Message struct)
 */
export interface WsMessage<T = unknown> {
	type: string;
	payload: T;
}

/**
 * Maps SDK event names to Go MessageType strings
 *
 * SDK uses colon-separated names (participant:joined)
 * Go uses dot-separated names (participant.joined)
 */
export const serverMessageTypeMap: Record<
	string,
	keyof import("./server-events").ServerEventMap
> = {
	connected: "connected",
	"participant.joined": "participant:joined",
	"participant.left": "participant:left",
	"participant.updated": "participant:updated",
	"chat.message": "chat:message",
	reaction: "reaction",
	"hand.raised": "hand:raised",
	"hand.lowered": "hand:lowered",
	"room.updated": "room:updated",
	"room.snapshot": "room:snapshot",
	"recording.started": "recording:started",
	"recording.stopped": "recording:stopped",
	"whiteboard.data": "whiteboard:data",
	"whiteboard.snapshot": "whiteboard:snapshot",
	"whiteboard.cursor": "whiteboard:cursor",
	"whiteboard.opened": "whiteboard:opened",
	"whiteboard.closed": "whiteboard:closed",
	"permission.changed": "permission:changed",
	error: "error",
	ping: "ping",
} as const;

/**
 * Maps SDK event names to Go MessageType strings for client events
 */
export const clientMessageTypeMap: Record<keyof ClientEventMap, string> = {
	"chat:send": "chat.send",
	"reaction:send": "reaction.send",
	"hand:raise": "hand.raise",
	"hand:lower": "hand.lower",
	"room:sync": "room.sync",
	"whiteboard:update": "whiteboard.update",
	"whiteboard:sync": "whiteboard.sync",
	"whiteboard:clear": "whiteboard.clear",
	"whiteboard:cursor": "whiteboard.cursor",
	"whiteboard:open": "whiteboard.open",
	"whiteboard:close": "whiteboard.close",
	"permission:grant": "permission.grant",
	"permission:revoke": "permission.revoke",
	pong: "pong",
} as const;
