/**
 * Whiteboard manager for Chalk SDK
 *
 * @packageDocumentation
 * @module @q9labs/chalk-core/managers
 */

import { ChalkError, ChalkErrorCode } from "../errors/chalk-error";
import type { Room } from "../room";
import { StateContainer } from "../state/state-container";
import type {
	WhiteboardCursor,
	WhiteboardPermission,
	WhiteboardSnapshot,
	WhiteboardUpdate,
} from "../types/entities/whiteboard";
import { TypedEventEmitter } from "../utils/typed-emitter";

/** Whiteboard manager state */
export interface WhiteboardState {
	/** Whether whiteboard is open */
	readonly isOpen: boolean;
	/** Whether local user can draw */
	readonly canDraw: boolean;
	/** Current elements on the whiteboard */
	readonly elements: readonly unknown[];
	/** Current files (images, etc.) */
	readonly files: Readonly<Record<string, unknown>>;
	/** Other participants' cursors */
	readonly cursors: readonly WhiteboardCursor[];
	/** Last sequence number */
	readonly lastSeq: number;
	/** Participant IDs who have whiteboard open */
	readonly openParticipants: readonly string[];
}

/** Whiteboard manager events */
export interface WhiteboardManagerEvents {
	/** Whiteboard update received */
	update: WhiteboardUpdate;
	/** Snapshot received */
	snapshot: WhiteboardSnapshot;
	/** Cursor update received */
	cursor: WhiteboardCursor;
	/** Permission changed */
	"permission:changed": WhiteboardPermission;
	/** Whiteboard opened by participant */
	opened: { participantId: string; displayName: string };
	/** Whiteboard closed by participant */
	closed: { participantId: string };
	/** Error occurred */
	error: ChalkError;
}

const CURSOR_DEBOUNCE_MS = 50;

/**
 * Manages whiteboard collaboration via WebSocket
 *
 * Whiteboard is ephemeral - content is cleared when the meeting truly ends.
 */
export class WhiteboardManager extends StateContainer<WhiteboardState> {
	private readonly events = new TypedEventEmitter<WhiteboardManagerEvents>();
	private room: Room | null = null;
	private cursors = new Map<string, WhiteboardCursor>();
	private updateDebounceTimeout: ReturnType<typeof setTimeout> | null = null;
	private cursorDebounceTimeout: ReturnType<typeof setTimeout> | null = null;
	private pendingElements: unknown[] | null = null;
	private pendingFiles: Record<string, unknown> | null = null;
	private lastSeqByParticipant = new Map<string, number>();
	private openParticipants = new Set<string>();

	constructor(_debug = false) {
		super({
			isOpen: false,
			canDraw: true, // Default to true, will be updated from API
			elements: [],
			files: {},
			cursors: [],
			lastSeq: 0,
			openParticipants: [],
		});
	}

	/** Subscribe to whiteboard events */
	on<K extends keyof WhiteboardManagerEvents>(
		event: K,
		handler: (data: WhiteboardManagerEvents[K]) => void,
	): () => void {
		return this.events.on(event, handler);
	}

	/** Attach Room instance */
	attachRoom(room: Room): void {
		this.room = room;
		this.setupRoomListeners();
		this.syncFromRoom();
	}

	private syncFromRoom(): void {
		if (!this.room) return;

		// Check local participant's permission
		const canDraw = this.room.canDrawWhiteboard();
		this.setState({ canDraw });
	}

	/**
	 * Merge incoming elements with existing elements
	 * Handles delta updates by updating/adding elements by ID and version
	 */
	private mergeElements(
		existing: Array<{ id: string; version?: number; isDeleted?: boolean }>,
		incoming: Array<{ id: string; version?: number; isDeleted?: boolean }>,
	): unknown[] {
		const elementMap = new Map(existing.map((e) => [e.id, e]));

		for (const element of incoming) {
			if (element.isDeleted) {
				elementMap.delete(element.id);
			} else {
				const current = elementMap.get(element.id);
				// Accept if new element or newer version
				if (!current || (element.version ?? 0) >= (current.version ?? 0)) {
					elementMap.set(element.id, element);
				}
			}
		}

		return Array.from(elementMap.values());
	}

	private setupRoomListeners(): void {
		if (!this.room) return;

		this.room.on("whiteboard-update", (data) => {
			const update: WhiteboardUpdate = {
				schemaVersion: data.schemaVersion,
				sceneId: data.sceneId,
				syncAll: data.syncAll,
				participantId: data.participantId,
				displayName: data.displayName,
				elements: data.elements,
				files: data.files,
				seq: data.seq,
				timestamp: new Date(),
			};

			if (data.schemaVersion === 2) {
				const currentState = this.getState();
				this.setState({ lastSeq: Math.max(currentState.lastSeq, data.seq) });
				this.events.emit("update", update);
				return;
			}

			// Only apply if sequence is newer
			const lastSeq = this.lastSeqByParticipant.get(data.participantId) ?? 0;
			if (data.seq > lastSeq) {
				// Merge incoming elements with existing (delta updates)
				const currentState = this.getState();
				const mergedElements = this.mergeElements(
					currentState.elements as Array<{ id: string; version?: number; isDeleted?: boolean }>,
					data.elements as Array<{ id: string; version?: number; isDeleted?: boolean }>,
				);
				const mergedFiles = { ...currentState.files, ...(data.files ?? {}) };

				this.lastSeqByParticipant.set(data.participantId, data.seq);
				this.setState({
					elements: mergedElements,
					files: mergedFiles,
					lastSeq: Math.max(currentState.lastSeq, data.seq),
				});
			}

			this.events.emit("update", update);
		});

		this.room.on("whiteboard-snapshot", (data) => {
			const snapshot: WhiteboardSnapshot = {
				schemaVersion: data.schemaVersion,
				roomId: data.roomId,
				sceneId: data.sceneId,
				elements: data.elements,
				files: data.files,
				appState: data.appState,
				updatedAtMs: data.updatedAtMs,
				lastSeq: data.lastSeq,
			};

			this.lastSeqByParticipant.clear();
			this.setState({
				elements: data.elements,
				files: data.files,
				lastSeq: data.lastSeq,
			});
			this.events.emit("snapshot", snapshot);
		});

		this.room.on("whiteboard-cursor", (data) => {
			const cursor: WhiteboardCursor = {
				participantId: data.participantId,
				displayName: data.displayName,
				x: data.x,
				y: data.y,
				timestamp: new Date(),
			};

			this.cursors.set(data.participantId, cursor);
			this.setState({ cursors: Array.from(this.cursors.values()) });
			this.events.emit("cursor", cursor);
		});

		this.room.on("whiteboard-permission-changed", (data) => {
			// Update local permission if it's for us
			const localId = this.room?.localParticipant?.id;
			if (data.participantId === localId) {
				this.setState({ canDraw: data.canDraw });
			}

			const permission: WhiteboardPermission = {
				participantId: data.participantId,
				feature: "whiteboard",
				canDraw: data.canDraw,
				grantedBy: "", // Not provided by room event
				timestamp: new Date(),
			};

			this.events.emit("permission:changed", permission);
		});

		this.room.on("whiteboard-opened", (data) => {
			this.openParticipants.add(data.participantId);
			this.setState({
				isOpen: true,
				openParticipants: Array.from(this.openParticipants),
			});
			this.events.emit("opened", {
				participantId: data.participantId,
				displayName: data.displayName,
			});
		});

		this.room.on("whiteboard-closed", (data) => {
			this.openParticipants.delete(data.participantId);
			this.cursors.delete(data.participantId);
			this.setState({
				isOpen: false,
				openParticipants: Array.from(this.openParticipants),
				cursors: Array.from(this.cursors.values()),
			});
			this.events.emit("closed", { participantId: data.participantId });
		});

		this.room.on("participant-left", (participantId) => {
			this.openParticipants.delete(participantId);
			this.cursors.delete(participantId);
			this.setState({
				openParticipants: Array.from(this.openParticipants),
				cursors: Array.from(this.cursors.values()),
			});
		});
	}

	/** Open whiteboard locally and notify others */
	open(): void {
		if (!this.room) {
			throw new ChalkError(
				ChalkErrorCode.NOT_IN_ROOM,
				"Not connected to a room",
			);
		}

		this.room.openWhiteboard();
		this.setState({ isOpen: true });

		// Request current state
		this.room.requestWhiteboardSync();
	}

	/** Close whiteboard locally and notify others */
	close(): void {
		if (!this.room) {
			throw new ChalkError(
				ChalkErrorCode.NOT_IN_ROOM,
				"Not connected to a room",
			);
		}

		this.room.closeWhiteboard();
		this.setState({ isOpen: false });
	}

	/** Toggle whiteboard open/closed */
	toggle(): void {
		if (this.getState().isOpen) {
			this.close();
		} else {
			this.open();
		}
	}

	/** Request full sync from other participants */
	requestSync(): void {
		if (!this.room) {
			throw new ChalkError(
				ChalkErrorCode.NOT_IN_ROOM,
				"Not connected to a room",
			);
		}

		this.room.requestWhiteboardSync();
	}

	/**
	 * Send whiteboard update (debounced 100-200ms)
	 * @param elements - Excalidraw elements array
	 * @param files - Optional files map
	 */
	sendUpdate(
		elements: unknown[],
		files?: Record<string, unknown>,
		seqOverride?: number,
	): void {
		if (!this.room) {
			throw new ChalkError(
				ChalkErrorCode.NOT_IN_ROOM,
				"Not connected to a room",
			);
		}

		if (!this.getState().canDraw) {
			return; // Silently ignore if no permission
		}

		// Store pending data
		this.pendingElements = elements;
		this.pendingFiles = files ?? null;

		// Debounce
		if (this.updateDebounceTimeout) {
			clearTimeout(this.updateDebounceTimeout);
		}

		this.updateDebounceTimeout = setTimeout(() => {
			if (this.pendingElements && this.room) {
				const seq = typeof seqOverride === "number" ? seqOverride : Date.now();
				this.room.sendWhiteboardUpdate(
					this.pendingElements,
					this.pendingFiles ?? undefined,
					seq,
				);

				// Merge sent elements with existing state (pendingElements are deltas)
				const currentState = this.getState();
				const mergedElements = this.mergeElements(
					currentState.elements as Array<{ id: string; version?: number; isDeleted?: boolean }>,
					this.pendingElements as Array<{ id: string; version?: number; isDeleted?: boolean }>,
				);
				const mergedFiles = { ...currentState.files, ...(this.pendingFiles ?? {}) };

				this.setState({
					elements: mergedElements,
					files: mergedFiles,
					lastSeq: Math.max(currentState.lastSeq, seq),
				});
				this.pendingElements = null;
				this.pendingFiles = null;
			}
		}, 100);
	}

	/**
	 * Send cursor position (debounced)
	 */
	sendCursor(x: number, y: number): void {
		if (!this.room) return;

		// Debounce cursor updates
		if (this.cursorDebounceTimeout) {
			clearTimeout(this.cursorDebounceTimeout);
		}

		this.cursorDebounceTimeout = setTimeout(() => {
			this.room?.sendWhiteboardCursor(x, y);
		}, CURSOR_DEBOUNCE_MS);
	}

	/** Clear the whiteboard (host only) */
	clear(): void {
		if (!this.room) {
			throw new ChalkError(
				ChalkErrorCode.NOT_IN_ROOM,
				"Not connected to a room",
			);
		}

		this.room.clearWhiteboard();
		this.lastSeqByParticipant.clear();
		this.setState({ elements: [], files: {}, lastSeq: 0 });
	}

	/** Grant drawing permission to a participant (host only) */
	grantPermission(participantId: string): void {
		if (!this.room) {
			throw new ChalkError(
				ChalkErrorCode.NOT_IN_ROOM,
				"Not connected to a room",
			);
		}

		this.room.grantWhiteboardPermission(participantId);
	}

	/** Revoke drawing permission from a participant (host only) */
	revokePermission(participantId: string): void {
		if (!this.room) {
			throw new ChalkError(
				ChalkErrorCode.NOT_IN_ROOM,
				"Not connected to a room",
			);
		}

		this.room.revokeWhiteboardPermission(participantId);
	}

	/** Cleanup resources */
	dispose(): void {
		if (this.updateDebounceTimeout) {
			clearTimeout(this.updateDebounceTimeout);
		}
		if (this.cursorDebounceTimeout) {
			clearTimeout(this.cursorDebounceTimeout);
		}
		this.lastSeqByParticipant.clear();
		this.cursors.clear();
		this.openParticipants.clear();
		this.events.removeAllListeners();
	}
}
