/**
 * Room lifecycle manager for Chalk SDK
 *
 * @packageDocumentation
 * @module @q9labs/chalk-core/managers
 */

import { ChalkError, ChalkErrorCode } from "../errors/chalk-error";
import type { Room } from "../room";
import { StateContainer } from "../state/state-container";
import type { RoomStatus } from "../types";
import { createLogger, type Logger } from "../utils/logger";
import { TypedEventEmitter } from "../utils/typed-emitter";

/** Options for joining a room */
export interface JoinOptions {
	/** Display name for the participant */
	userName: string;
	/** Enable audio on join */
	audioEnabled?: boolean;
	/** Enable video on join */
	videoEnabled?: boolean;
	/** Custom metadata to attach to participant */
	metadata?: Record<string, unknown>;
}

/** Options for leaving a room */
export interface LeaveOptions {
	/** End the room for all participants (host only) */
	endForAll?: boolean | (() => boolean);
}

/** Room manager state */
export interface RoomState {
	/** Current connection status */
	readonly status: RoomStatus;
	/** Room ID (null if not connected) */
	readonly roomId: string | null;
	/** Room name */
	readonly roomName: string | null;
	/** Whether join is in progress */
	readonly isJoining: boolean;
	/** Host participant ID */
	readonly hostId: string | null;
}

/** Room manager events */
export interface RoomManagerEvents {
	/** Room connection established */
	connected: { roomId: string };
	/** Room disconnected */
	disconnected: { reason: string };
	/** Connection status changed */
	"status:changed": { status: RoomStatus };
	/** Room ended by host */
	"room:ended": { reason: string };
	/** Error occurred */
	error: ChalkError;
}

/**
 * Manages room lifecycle - joining, leaving, reconnection
 */
export class RoomManager extends StateContainer<RoomState> {
	private readonly events = new TypedEventEmitter<RoomManagerEvents>();
	private readonly log: Logger = createLogger("Room");
	private room: Room | null = null;

	constructor(_debug = false) {
		super({
			status: "disconnected",
			roomId: null,
			roomName: null,
			isJoining: false,
			hostId: null,
		});
	}

	/** Subscribe to room events */
	on<K extends keyof RoomManagerEvents>(
		event: K,
		handler: (data: RoomManagerEvents[K]) => void,
	): () => void {
		return this.events.on(event, handler);
	}

	/** Get underlying Room instance */
	getRoom(): Room | null {
		return this.room;
	}

	/** Attach an existing Room instance */
	attachRoom(room: Room): void {
		this.room = room;
		this.setupRoomListeners();
		this.syncStateFromRoom();
	}

	private syncStateFromRoom(): void {
		if (!this.room) return;

		this.setState({
			status: this.room.status,
			roomId: this.room.id,
			roomName: this.room.info?.name ?? null,
			hostId: null, // Not available in RoomInfo
		});
	}

	private setupRoomListeners(): void {
		if (!this.room) return;

		this.room.on("status-changed", (status) => {
			this.log.state("status", status);
			this.setState({ status });
			this.events.emit("status:changed", { status });

			if (status === "connected") {
				this.log.info("Connected", { roomId: this.room!.id });
				this.events.emit("connected", { roomId: this.room!.id });
			} else if (status === "disconnected") {
				this.log.info("Disconnected", { reason: "connection_lost" });
				this.events.emit("disconnected", { reason: "connection_lost" });
			}
		});

		this.room.on("error", (error) => {
			const chalkError = new ChalkError(
				ChalkErrorCode.UNKNOWN,
				error.message ?? "Room error",
				{ details: { code: error.code, message: error.message } },
			);
			this.events.emit("error", chalkError);
		});
	}

	/** Join a room (requires ChalkClient to actually connect) */
	async join(roomId: string, _options: JoinOptions): Promise<void> {
		if (this.getState().isJoining) {
			throw new ChalkError(
				ChalkErrorCode.ALREADY_IN_ROOM,
				"Already joining a room",
			);
		}

		if (this.getState().status === "connected") {
			throw new ChalkError(
				ChalkErrorCode.ALREADY_IN_ROOM,
				"Already connected to a room",
			);
		}

		this.log.info("Join requested", { roomId });
		this.setState({ isJoining: true, status: "connecting" });
	}

	/** Mark join as complete (called by ChalkSession after ChalkClient joins) */
	joinComplete(room: Room): void {
		this.attachRoom(room);
		this.setState({
			isJoining: false,
			status: "connected",
			roomId: room.id,
		});
		this.events.emit("connected", { roomId: room.id });
	}

	/** Mark join as failed */
	joinFailed(error: ChalkError): void {
		this.setState({
			isJoining: false,
			status: "failed",
		});
		this.events.emit("error", error);
	}

	/** Leave the current room */
	async leave(options?: LeaveOptions): Promise<void> {
		if (!this.room) {
			throw new ChalkError(
				ChalkErrorCode.NOT_IN_ROOM,
				"Not connected to a room",
			);
		}

		const shouldEndForAll =
			typeof options?.endForAll === "function"
				? options.endForAll()
				: (options?.endForAll ?? false);

		this.log.info("Leaving", { endForAll: shouldEndForAll });

		if (shouldEndForAll) {
			// TODO: Call API to end room for all
		}

		await this.room.leave();
		this.room = null;

		this.setState({
			status: "disconnected",
			roomId: null,
			roomName: null,
			hostId: null,
		});

		this.log.info("Left room");
		this.events.emit("disconnected", { reason: "user_left" });
	}

	/** Cleanup resources */
	dispose(): void {
		if (this.room) {
			this.room.leave();
			this.room = null;
		}
		this.events.removeAllListeners();
	}
}
