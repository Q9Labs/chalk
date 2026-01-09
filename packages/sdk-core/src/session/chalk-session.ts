/**
 * ChalkSession - Main orchestrator for Chalk SDK
 *
 * @packageDocumentation
 * @module @q9labs/chalk-core/session
 */

import { ChalkClient } from "../client";
import { ChalkError } from "../errors/chalk-error";
import { ChatManager } from "../managers/chat-manager";
import { InteractionManager } from "../managers/interaction-manager";
import { MediaManager } from "../managers/media-manager";
import { ParticipantManager } from "../managers/participant-manager";
import { RecordingManager } from "../managers/recording-manager";
import type { JoinOptions, LeaveOptions } from "../managers/room-manager";
import { RoomManager } from "../managers/room-manager";
import { ScreenShareManager } from "../managers/screen-share-manager";
import { UIManager } from "../managers/ui-manager";
import { WhiteboardManager } from "../managers/whiteboard-manager";
import type { Room } from "../room";
import { createLogger, initLogging, type Logger } from "../utils/logger";
import { TypedEventEmitter } from "../utils/typed-emitter";

/** ChalkSession configuration */
export interface ChalkSessionConfig {
	/** Base API URL */
	apiUrl: string;
	/** WebSocket URL (optional, derived from apiUrl if not provided) */
	wsUrl?: string;
	/** JWT access token */
	token?: string;
	/** Token provider for refresh */
	tokenProvider?: () => Promise<string>;
	/** API key (for server-to-server auth) */
	apiKey?: string;
	/** Enable debug logging */
	debug?: boolean;
}

/** ChalkSession events */
export interface ChalkSessionEvents {
	/** Successfully connected to room */
	connected: { roomId: string };
	/** Disconnected from room */
	disconnected: { reason: string };
	/** Connection status changed */
	"status:changed": { status: string };
	/** Error occurred */
	error: ChalkError;
	/** Token expired (need to provide new token) */
	"token:expired": void;
}

/**
 * ChalkSession orchestrates all managers and provides
 * a unified interface for video conferencing.
 *
 * @example
 * ```ts
 * const session = new ChalkSession({
 *   apiUrl: 'https://api.chalk.video',
 *   token: 'jwt_xxx',
 * });
 *
 * await session.join('room_123', { userName: 'John' });
 *
 * // Access managers
 * await session.media.toggleVideo();
 * session.chat.sendMessage('Hello!');
 * ```
 */
export class ChalkSession extends TypedEventEmitter<ChalkSessionEvents> {
	/** Room lifecycle manager */
	readonly room: RoomManager;

	/** Participant list manager */
	readonly participants: ParticipantManager;

	/** Video/audio manager */
	readonly media: MediaManager;

	/** Screen share manager */
	readonly screenShare: ScreenShareManager;

	/** Chat messages manager */
	readonly chat: ChatManager;

	/** Recording manager */
	readonly recording: RecordingManager;

	/** Reactions and hand raise manager */
	readonly interactions: InteractionManager;

	/** UI state manager */
	readonly ui: UIManager;

	/** Whiteboard collaboration manager */
	readonly whiteboard: WhiteboardManager;

	private readonly client: ChalkClient;
	private readonly log: Logger;

	constructor(config: ChalkSessionConfig) {
		super();
		const debug = config.debug ?? false;

		// Initialize global logging
		initLogging(debug);
		this.log = createLogger("Session");

		this.log.info("Initializing", { apiUrl: config.apiUrl });

		// Initialize ChalkClient for API/WebRTC
		this.client = new ChalkClient({
			apiUrl: config.apiUrl,
			wsUrl: config.wsUrl,
			token: config.token,
			tokenProvider: config.tokenProvider,
			apiKey: config.apiKey,
			debug,
		});

		// Initialize all managers
		this.room = new RoomManager(debug);
		this.participants = new ParticipantManager();
		this.media = new MediaManager();
		this.screenShare = new ScreenShareManager();
		this.chat = new ChatManager();
		this.recording = new RecordingManager();
		this.interactions = new InteractionManager();
		this.ui = new UIManager();
		this.whiteboard = new WhiteboardManager();

		this.setupEventForwarding();
	}

	private setupEventForwarding(): void {
		// Forward room events
		this.room.on("connected", (data) => {
			this.emit("connected", data);
		});

		this.room.on("disconnected", (data) => {
			this.emit("disconnected", data);
		});

		this.room.on("status:changed", (data) => {
			this.emit("status:changed", data);
		});

		this.room.on("error", (error) => {
			this.emit("error", error);
		});

		// Forward errors from all managers
		this.media.on("error", (error) => this.emit("error", error));
		this.screenShare.on("error", (error) => this.emit("error", error));
		this.chat.on("error", (error) => this.emit("error", error));
		this.recording.on("error", (error) => this.emit("error", error));
		this.interactions.on("error", (error) => this.emit("error", error));
		this.whiteboard.on("error", (error) => this.emit("error", error));

		// Forward token expired from client
		this.client.on("token-expired", () => {
			this.emit("token:expired", undefined);
		});
	}

	private attachRoomToManagers(room: Room): void {
		this.room.attachRoom(room);
		this.participants.attachRoom(room);
		this.media.attachRoom(room);
		this.screenShare.attachRoom(room);
		this.chat.attachRoom(room);
		this.recording.attachRoom(room);
		this.interactions.attachRoom(room);
		this.whiteboard.attachRoom(room);

		// Set up recording API callbacks
		this.recording.setApiCallbacks(
			() => this.client.startRecording(),
			() => this.client.stopRecording(),
		);
	}

	/**
	 * Join a room
	 *
	 * @param roomId - Room ID to join
	 * @param options - Join options including userName
	 */
	async join(roomId: string, options: JoinOptions): Promise<void> {
		this.log.info("Joining room", { roomId, displayName: options.userName });

		try {
			// Signal join starting
			await this.room.join(roomId, options);

			// Actually join via ChalkClient
			const room = await this.client.joinRoom(roomId, {
				displayName: options.userName,
				audio: options.audioEnabled,
				video: options.videoEnabled,
				metadata: options.metadata,
			});

			// Attach room to all managers
			this.attachRoomToManagers(room);

			// Mark join complete
			this.room.joinComplete(room);

			this.log.info("Room joined", { roomId });
		} catch (err) {
			const error = ChalkError.wrap(err);
			this.log.error("Join failed", { roomId, code: error.code });
			this.room.joinFailed(error);
			throw error;
		}
	}

	/**
	 * Leave the current room
	 *
	 * @param options - Leave options (endForAll for hosts)
	 */
	async leave(options?: LeaveOptions): Promise<void> {
		this.log.info("Leaving room");

		try {
			await this.room.leave(options);
			this.client.disconnect();
			this.log.info("Left room");
		} catch (err) {
			const error = ChalkError.wrap(err);
			this.log.error("Leave failed", { code: error.code });
			this.emit("error", error);
			throw error;
		}
	}

	/**
	 * Create a new room (requires API key or host permissions)
	 *
	 * @param name - Optional room name
	 * @param config - Optional room configuration
	 * @returns Room ID
	 */
	async createRoom(
		name?: string,
		config?: Record<string, unknown>,
	): Promise<string> {
		try {
			return await this.client.createRoom(name, config);
		} catch (err) {
			const error = ChalkError.wrap(err);
			this.emit("error", error);
			throw error;
		}
	}

	/**
	 * End a room for all participants (host only)
	 *
	 * @param roomId - Room ID to end
	 */
	async endRoom(roomId: string): Promise<void> {
		try {
			await this.client.endRoom(roomId);
		} catch (err) {
			const error = ChalkError.wrap(err);
			this.emit("error", error);
			throw error;
		}
	}

	/**
	 * Remove a participant from the room (host only)
	 *
	 * @param participantId - Participant ID to remove
	 */
	async removeParticipant(participantId: string): Promise<void> {
		try {
			await this.client.removeParticipant(participantId);
		} catch (err) {
			const error = ChalkError.wrap(err);
			this.emit("error", error);
			throw error;
		}
	}

	/** Get current connection status */
	get status(): string {
		return this.room.getState().status;
	}

	/** Whether currently connected to a room */
	get isConnected(): boolean {
		return this.room.getState().status === "connected";
	}

	/** Current room ID (null if not connected) */
	get roomId(): string | null {
		return this.room.getState().roomId;
	}

	/** Get underlying ChalkClient (for advanced use) */
	get chalkClient(): ChalkClient {
		return this.client;
	}

	/**
	 * Cleanup all resources
	 */
	dispose(): void {
		this.log.info("Disposing session");

		this.room.dispose();
		this.participants.dispose();
		this.media.dispose();
		this.screenShare.dispose();
		this.chat.dispose();
		this.recording.dispose();
		this.interactions.dispose();
		this.ui.dispose();
		this.whiteboard.dispose();

		this.client.disconnect();
		this.removeAllListeners();

		this.log.info("Session disposed");
	}
}
