/**
 * Whiteboard entity types for Chalk SDK
 *
 * @packageDocumentation
 * @module @q9labs/chalk-core/types
 */
import type { AppState } from "@q9labs/chalk-whiteboard";

/**
 * Whiteboard permission feature
 */
export type WhiteboardFeature = "whiteboard" | "annotations";

/**
 * Cursor position for a participant on the whiteboard
 */
export interface WhiteboardCursor {
	/** Participant ID */
	participantId: string;

	/** Display name of the participant */
	displayName: string;

	/** X coordinate on the canvas */
	x: number;

	/** Y coordinate on the canvas */
	y: number;

	/** When the cursor was last updated */
	timestamp: Date;
}

/**
 * Whiteboard state snapshot
 *
 * Whiteboard is ephemeral - content is cleared when the meeting truly ends
 * (all participants leave).
 */
export interface WhiteboardSnapshot {
	/** Wire schema version (v2 = 2) */
	schemaVersion?: number;

	/** ConferenceSession ID */
	roomId: string;

	/** Scene epoch; changes on clear */
	sceneId?: string;

	/** Excalidraw elements array */
	elements: unknown[];

	/** Image files map */
	files: Record<string, unknown>;

	/** Excalidraw app state (view settings) */
	appState: AppState;

	/** Snapshot updated timestamp (ms) */
	updatedAtMs?: number;

	/** Last sequence number for ordering */
	lastSeq: number;
}

/**
 * Whiteboard update from a participant
 */
export interface WhiteboardUpdate {
	/** Wire schema version (v2 = 2) */
	schemaVersion?: number;

	/** Scene epoch; changes on clear */
	sceneId?: string;

	/** Whether this update represents a full-scene sync */
	syncAll?: boolean;

	/** Participant ID who made the update */
	participantId: string;

	/** Display name of the participant */
	displayName: string;

	/** Updated Excalidraw elements */
	elements: unknown[];

	/** Updated files (if any) */
	files?: Record<string, unknown>;

	/** Sequence number for ordering */
	seq: number;

	/** When the update was made */
	timestamp: Date;
}

/**
 * Permission change for whiteboard access
 */
export interface WhiteboardPermission {
	/** Participant ID whose permission changed */
	participantId: string;

	/** Feature the permission applies to */
	feature: WhiteboardFeature;

	/** Whether the participant can draw */
	canDraw: boolean;

	/** Participant ID who granted/revoked the permission */
	grantedBy: string;

	/** When the permission was changed */
	timestamp: Date;
}
