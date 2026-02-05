// Excalidraw types used by our whiteboard sync

export interface ExcalidrawElement {
	id: string;
	version: number;
	isDeleted?: boolean;
	// Other properties are opaque to our sync engine
	[key: string]: unknown;
}

export type AppState = Record<string, unknown>;

export type BinaryFiles = Record<string, BinaryFileData>;

export interface BinaryFileData {
	mimeType: string;
	id: string;
	dataURL: string;
	created: number;
	lastRetrieved?: number;
}

export interface WhiteboardState {
	elements: readonly ExcalidrawElement[];
	files: BinaryFiles;
	appState: Partial<AppState>;
	lastSeq: number;
}

export interface WhiteboardUpdate {
	participantId: string;
	displayName: string;
	elements: readonly ExcalidrawElement[];
	files?: BinaryFiles;
	seq: number;
	timestamp: Date;
}

export interface WhiteboardCursor {
	participantId: string;
	displayName: string;
	x: number;
	y: number;
	timestamp: Date;
}

export interface WhiteboardPermissions {
	canDraw: boolean;
	canGrant: boolean; // is host
	participants: Map<string, boolean>;
}

export interface WhiteboardConfig {
	/** Debounce interval for sending updates (ms) */
	debounceMs?: number;
	/** Throttle interval for cursor updates (ms) */
	cursorThrottleMs?: number;
	/** Max elements before warning */
	maxElements?: number;
	/** Max serialized payload size (bytes) */
	maxPayloadBytes?: number;
	/** Max serialized file size (bytes) */
	maxFileBytes?: number;
}

export const DEFAULT_CONFIG: Required<WhiteboardConfig> = {
	debounceMs: 150,
	cursorThrottleMs: 16, // ~60fps
	maxElements: 5000,
	maxPayloadBytes: 32 * 1024 * 1024, // 32MB
	maxFileBytes: 32 * 1024 * 1024, // 32MB
};
