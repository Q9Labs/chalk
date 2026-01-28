/**
 * ChalkSession - Main orchestrator for Chalk SDK
 *
 * @packageDocumentation
 * @module @q9labs/chalk-core/session
 */

import { Effect, ManagedRuntime } from "effect";
import { ChalkClient } from "../client";
import { ChalkError } from "../errors/chalk-error";
import { ChatManager } from "../managers/chat-manager";
import { InteractionManager } from "../managers/interaction-manager";
import { RecordingManager } from "../managers/recording-manager";
import { ScreenShareManager } from "../managers/screen-share-manager";
import { UIManager } from "../managers/ui-manager";
import { WhiteboardManager } from "../managers/whiteboard-manager";
import type { Room } from "../room";
import { makeManagerServicesLayer } from "../effect/services/manager-layers";
import { RoomService } from "../effect/services/room-service";
import { ParticipantService } from "../effect/services/participant-service";
import { MediaService } from "../effect/services/media-service";
import type {
	JoinOptions,
	LeaveOptions,
} from "../effect/services/room-service";
import type {
	RoomState,
	ParticipantState,
	MediaState,
	MediaDeviceData,
} from "../effect/schemas/manager-state";
import { RoomError } from "../effect/errors";
import { TypedEventEmitter } from "../utils/typed-emitter";
import { wideEvents } from "../wide-events/index";

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
	/** Use demo API endpoints (demoJoin instead of addParticipant) */
	demoMode?: boolean;
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
/** Room events type */
type RoomManagerEvents = {
	connected: { roomId: string };
	disconnected: { reason: string };
	"status:changed": { status: RoomState["status"] };
	"room:ended": { reason: string };
	error: ChalkError;
};

/** Participants events type */
type ParticipantManagerEvents = {
	"participant:joined": { participant: ParticipantState["participants"][0] };
	"participant:left": { participantId: string };
	"participant:updated": {
		participantId: string;
		participant: ParticipantState["participants"][0];
	};
	"active-speaker:changed": { participant: ParticipantState["activeSpeaker"] };
};

/** Media events type */
type MediaManagerEvents = {
	"video:changed": { enabled: boolean; track: MediaStreamTrack | null };
	"audio:changed": { enabled: boolean; track: MediaStreamTrack | null };
	"devices:changed": { devices: readonly MediaDeviceData[] };
	error: ChalkError;
};

export class ChalkSession extends TypedEventEmitter<ChalkSessionEvents> {
	/** Room API object with state and events */
	readonly room: {
		readonly getState: () => RoomState;
		readonly getRoom: () => Room | null;
		readonly on: <K extends keyof RoomManagerEvents>(
			event: K,
			handler: (data: RoomManagerEvents[K]) => void,
		) => () => void;
		readonly subscribe: (
			listener: (state: RoomState, prevState: RoomState) => void,
		) => () => void;
		_state: RoomState;
		_emitter: TypedEventEmitter<RoomManagerEvents>;
		_listeners: Set<(state: RoomState, prevState: RoomState) => void>;
	};

	/** Participants API object with state and events */
	readonly participants: {
		readonly getState: () => ParticipantState;
		readonly on: <K extends keyof ParticipantManagerEvents>(
			event: K,
			handler: (data: ParticipantManagerEvents[K]) => void,
		) => () => void;
		readonly subscribe: (
			listener: (state: ParticipantState, prevState: ParticipantState) => void,
		) => () => void;
		readonly getParticipant: (
			id: string,
		) => ParticipantState["participants"][0] | undefined;
		readonly remoteParticipants: readonly ParticipantState["participants"][0][];
		_state: ParticipantState;
		_emitter: TypedEventEmitter<ParticipantManagerEvents>;
		_listeners: Set<(state: ParticipantState, prevState: ParticipantState) => void>;
	};

	/** Media API object with state and events */
	readonly media: {
		readonly getState: () => MediaState;
		readonly on: <K extends keyof MediaManagerEvents>(
			event: K,
			handler: (data: MediaManagerEvents[K]) => void,
		) => () => void;
		readonly subscribe: (
			listener: (state: MediaState, prevState: MediaState) => void,
		) => () => void;
		readonly toggleVideo: () => Promise<boolean>;
		readonly toggleAudio: () => Promise<boolean>;
		readonly selectCamera: (deviceId: string) => Promise<void>;
		readonly selectMicrophone: (deviceId: string) => Promise<void>;
		readonly selectSpeaker: (deviceId: string) => Promise<void>;
		readonly undoDeviceChange: () => void;
		readonly refreshDevices: () => Promise<readonly MediaDeviceData[]>;
		readonly cameras: readonly MediaDeviceData[];
		readonly microphones: readonly MediaDeviceData[];
		readonly speakers: readonly MediaDeviceData[];
		_state: MediaState;
		_emitter: TypedEventEmitter<MediaManagerEvents>;
		_listeners: Set<(state: MediaState, prevState: MediaState) => void>;
	};

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
	private _runtime: ManagedRuntime.ManagedRuntime<
		RoomService | ParticipantService | MediaService,
		never
	>;
	private _currentRoom: Room | null = null;

	constructor(config: ChalkSessionConfig) {
		super();
		const debug = config.debug ?? false;

		// Initialize ChalkClient for API/WebRTC
		this.client = new ChalkClient({
			apiUrl: config.apiUrl,
			wsUrl: config.wsUrl,
			token: config.token,
			tokenProvider: config.tokenProvider,
			apiKey: config.apiKey,
			debug,
			demoMode: config.demoMode,
		});

		// Create managed runtime for Effect services
		this._runtime = ManagedRuntime.make(makeManagerServicesLayer(debug));

		// Initialize API objects
		const roomEmitter = new TypedEventEmitter<RoomManagerEvents>();
		const participantEmitter =
			new TypedEventEmitter<ParticipantManagerEvents>();
		const mediaEmitter = new TypedEventEmitter<MediaManagerEvents>();

		const initialRoomState: RoomState = {
			status: "disconnected",
			roomId: null,
			roomName: null,
			isJoining: false,
			hostId: null,
		};

		const initialParticipantState: ParticipantState = {
			participants: [],
			activeSpeaker: null,
			localParticipant: null,
			count: 0,
		};

		const initialMediaState: MediaState = {
			isVideoEnabled: false,
			isAudioEnabled: false,
			isTogglingVideo: false,
			isTogglingAudio: false,
			selectedCamera: null,
			selectedMicrophone: null,
			selectedSpeaker: null,
			devices: [],
		};

		const roomListeners = new Set<
			(state: RoomState, prevState: RoomState) => void
		>();
		const participantListeners = new Set<
			(state: ParticipantState, prevState: ParticipantState) => void
		>();
		const mediaListeners = new Set<
			(state: MediaState, prevState: MediaState) => void
		>();

		const self = this;

		// Helper to update room state and notify listeners
		const updateRoomState = (newState: RoomState) => {
			const prevState = self.room._state;
			self.room._state = newState;
			roomListeners.forEach((listener) => {
				try {
					listener(newState, prevState);
				} catch {
					// Silently catch listener errors
				}
			});
		};

		// Helper to update participant state and notify listeners
		const updateParticipantState = (newState: ParticipantState) => {
			const prevState = self.participants._state;
			self.participants._state = newState;
			participantListeners.forEach((listener) => {
				try {
					listener(newState, prevState);
				} catch {
					// Silently catch listener errors
				}
			});
		};

		// Helper to update media state and notify listeners
		const updateMediaState = (newState: MediaState) => {
			const prevState = self.media._state;
			self.media._state = newState;
			mediaListeners.forEach((listener) => {
				try {
					listener(newState, prevState);
				} catch {
					// Silently catch listener errors
				}
			});
		};

		this.room = {
			_state: initialRoomState,
			_emitter: roomEmitter,
			_listeners: roomListeners,
			getState: () => this.room._state,
			getRoom: () => self._currentRoom,
			on: <K extends keyof RoomManagerEvents>(
				event: K,
				handler: (data: RoomManagerEvents[K]) => void,
			) => this.room._emitter.on(event, handler),
			subscribe: (
				listener: (state: RoomState, prevState: RoomState) => void,
			) => {
				roomListeners.add(listener);
				return () => {
					roomListeners.delete(listener);
				};
			},
		};

		this.participants = {
			_state: initialParticipantState,
			_emitter: participantEmitter,
			_listeners: participantListeners,
			getState: () => self.participants._state,
			on: <K extends keyof ParticipantManagerEvents>(
				event: K,
				handler: (data: ParticipantManagerEvents[K]) => void,
			) => self.participants._emitter.on(event, handler),
			subscribe: (
				listener: (state: ParticipantState, prevState: ParticipantState) => void,
			) => {
				participantListeners.add(listener);
				return () => {
					participantListeners.delete(listener);
				};
			},
			getParticipant: (id: string) =>
				self.participants._state.participants.find((p) => p.id === id),
			get remoteParticipants() {
				return self.participants._state.participants.filter((p) => !p.isLocal);
			},
		};

		const runtime = this._runtime;
		this.media = {
			_state: initialMediaState,
			_emitter: mediaEmitter,
			_listeners: mediaListeners,
			getState: () => self.media._state,
			on: <K extends keyof MediaManagerEvents>(
				event: K,
				handler: (data: MediaManagerEvents[K]) => void,
			) => self.media._emitter.on(event, handler),
			subscribe: (
				listener: (state: MediaState, prevState: MediaState) => void,
			) => {
				mediaListeners.add(listener);
				return () => {
					mediaListeners.delete(listener);
				};
			},
			toggleVideo: async () => {
				return runtime.runPromise(
					Effect.gen(function* () {
						const mediaSvc = yield* MediaService;
						return yield* mediaSvc.toggleVideo;
					}),
				);
			},
			toggleAudio: async () => {
				return runtime.runPromise(
					Effect.gen(function* () {
						const mediaSvc = yield* MediaService;
						return yield* mediaSvc.toggleAudio;
					}),
				);
			},
			selectCamera: async (deviceId: string) => {
				return runtime.runPromise(
					Effect.gen(function* () {
						const mediaSvc = yield* MediaService;
						yield* mediaSvc.selectCamera(deviceId);
					}),
				);
			},
			selectMicrophone: async (deviceId: string) => {
				return runtime.runPromise(
					Effect.gen(function* () {
						const mediaSvc = yield* MediaService;
						yield* mediaSvc.selectMicrophone(deviceId);
					}),
				);
			},
			selectSpeaker: async (deviceId: string) => {
				return runtime.runPromise(
					Effect.gen(function* () {
						const mediaSvc = yield* MediaService;
						yield* mediaSvc.selectSpeaker(deviceId);
					}),
				);
			},
			undoDeviceChange: () => {
				runtime.runSync(
					Effect.gen(function* () {
						const mediaSvc = yield* MediaService;
						yield* mediaSvc.undoDeviceChange;
					}),
				);
			},
			refreshDevices: async () => {
				return runtime.runPromise(
					Effect.gen(function* () {
						const mediaSvc = yield* MediaService;
						return yield* mediaSvc.refreshDevices;
					}),
				);
			},
			get cameras() {
				return self.media._state.devices.filter(
					(d: MediaDeviceData) => d.kind === "videoinput",
				);
			},
			get microphones() {
				return self.media._state.devices.filter(
					(d: MediaDeviceData) => d.kind === "audioinput",
				);
			},
			get speakers() {
				return self.media._state.devices.filter(
					(d: MediaDeviceData) => d.kind === "audiooutput",
				);
			},
		};

		// Store references to helpers for use in attachRoomToManagers
		(this as any)._updateRoomState = updateRoomState;
		(this as any)._updateParticipantState = updateParticipantState;
		(this as any)._updateMediaState = updateMediaState;

		// Initialize other managers (non-Effect)
		this.screenShare = new ScreenShareManager();
		this.chat = new ChatManager();
		this.recording = new RecordingManager();
		this.interactions = new InteractionManager();
		this.ui = new UIManager();
		this.whiteboard = new WhiteboardManager();

		// Emit session init event
		const initCtx = wideEvents.start("session.init");
		initCtx.set("config", { apiUrl: config.apiUrl, debug, demoMode: config.demoMode });
		initCtx.complete("success");

		this.setupEventForwarding();
		this._initEventBridges();
	}

	private setupEventForwarding(): void {
		// Forward room events
		this.room._emitter.on("connected", (data) => {
			this.emit("connected", data);
		});

		this.room._emitter.on("disconnected", (data) => {
			this.emit("disconnected", data);
		});

		this.room._emitter.on("status:changed", (data) => {
			this.emit("status:changed", data);
		});

		this.room._emitter.on("error", (error) => {
			this.emit("error", error);
		});

		// Forward errors from all managers
		this.media._emitter.on("error", (error) => this.emit("error", error));
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

	private _initEventBridges(): void {
		// State bridges are set up in attachRoomToManagers when room connects
		// This method is kept for initialization order consistency
	}

	private attachRoomToManagers(room: Room): void {
		// Store current room reference
		this._currentRoom = room;

		// Attach to non-Effect managers
		this.screenShare.attachRoom(room);
		this.chat.attachRoom(room);
		this.recording.attachRoom(room);
		this.interactions.attachRoom(room);
		this.whiteboard.attachRoom(room);

		// Attach to Effect services via runtime
		this._runtime
			.runPromise(
				Effect.gen(function* () {
					const roomSvc = yield* RoomService;
					const participantSvc = yield* ParticipantService;
					const mediaSvc = MediaService;

					yield* roomSvc.joinComplete(room);
					yield* participantSvc.attachRoom(room);
					yield* mediaSvc.pipe(Effect.andThen((ms) => ms.attachRoom(room)));
				}),
			)
			.catch(() => {
				// Room attachment failed - error already emitted via wide events in client
			});

		// Set up recording API callbacks
		this.recording.setApiCallbacks(
			() => this.client.startRecording(),
			() => this.client.stopRecording(),
		);

		// Bridge Room events to session state for React hooks
		this.setupRoomStateBridges(room);
	}

	/**
	 * Set up direct event bridges from Room to session state
	 * This ensures React hooks receive state updates
	 */
	private setupRoomStateBridges(room: Room): void {
		const updateRoomState = (this as any)._updateRoomState;
		const updateParticipantState = (this as any)._updateParticipantState;
		const updateMediaState = (this as any)._updateMediaState;

		// Helper to normalize participant for state
		const normalizeParticipant = (p: any) => ({
			id: p.id,
			displayName: p.displayName,
			role: p.role ?? "participant",
			isLocal: p.isLocal,
			videoEnabled: p.videoEnabled ?? false,
			audioEnabled: p.audioEnabled ?? false,
			isScreenSharing: p.isScreenSharing ?? false,
			isSpeaking: p.isSpeaking ?? false,
			handRaised: p.handRaised ?? false,
			connectionQuality: p.connectionQuality ?? 100,
			videoTrack: p.videoTrack ?? undefined,
			audioTrack: p.audioTrack ?? undefined,
			screenShareTrack: p.screenShareTrack ?? undefined,
			screenShareAudioTrack: p.screenShareAudioTrack ?? undefined,
		});

		// Sync initial room state
		updateRoomState({
			status: room.status,
			roomId: room.id,
			roomName: room.info?.name ?? null,
			isJoining: false,
			hostId: null,
		});

		// Sync initial participants
		const participants = Array.from(room.participants.values()).map(normalizeParticipant);
		const localParticipant = room.localParticipant
			? normalizeParticipant(room.localParticipant)
			: null;
		updateParticipantState({
			participants: localParticipant
				? [...participants.filter((p: any) => p.id !== localParticipant.id), localParticipant]
				: participants,
			localParticipant,
			activeSpeaker: null,
			count: participants.length + (localParticipant ? 1 : 0),
		});

		// Sync initial media state from local participant
		if (localParticipant) {
			updateMediaState({
				isVideoEnabled: localParticipant.videoEnabled,
				isAudioEnabled: localParticipant.audioEnabled,
				isTogglingVideo: false,
				isTogglingAudio: false,
				selectedCamera: null,
				selectedMicrophone: null,
				selectedSpeaker: null,
				devices: [],
			});
		}

		// Room status changes
		room.on("status-changed", (status) => {
			updateRoomState({
				status,
				roomId: room.id,
				roomName: room.info?.name ?? null,
				isJoining: false,
				hostId: null,
			});
			this.room._emitter.emit("status:changed", { status });
		});

		// Participant events
		room.on("participant-joined", (participant) => {
			const normalized = normalizeParticipant(participant);
			const currentState = this.participants._state;
			const updatedParticipants = [...currentState.participants.filter((p) => p.id !== normalized.id), normalized];
			updateParticipantState({
				...currentState,
				participants: updatedParticipants,
				count: updatedParticipants.length,
			});
			this.participants._emitter.emit("participant:joined", { participant: normalized });
		});

		room.on("participant-left", (participantId) => {
			const currentState = this.participants._state;
			const updatedParticipants = currentState.participants.filter((p) => p.id !== participantId);
			updateParticipantState({
				...currentState,
				participants: updatedParticipants,
				count: updatedParticipants.length,
			});
			this.participants._emitter.emit("participant:left", { participantId });
		});

		room.on("participant-updated", ({ participantId, participant }) => {
			const normalized = normalizeParticipant(participant);
			const currentState = this.participants._state;
			const updatedParticipants = currentState.participants.map((p) =>
				p.id === participantId ? normalized : p
			);

			// Also update localParticipant if it's the local user
			const localParticipant = normalized.isLocal ? normalized : currentState.localParticipant;

			updateParticipantState({
				...currentState,
				participants: updatedParticipants,
				localParticipant,
			});
			this.participants._emitter.emit("participant:updated", { participantId, participant: normalized });

			// Update media state if local participant changed
			if (normalized.isLocal) {
				const currentMediaState = this.media._state;
				updateMediaState({
					...currentMediaState,
					isVideoEnabled: normalized.videoEnabled,
					isAudioEnabled: normalized.audioEnabled,
				});
			}
		});

		room.on("active-speaker-changed", (speaker) => {
			const normalized = speaker ? normalizeParticipant(speaker) : null;
			const currentState = this.participants._state;
			updateParticipantState({
				...currentState,
				activeSpeaker: normalized,
			});
			this.participants._emitter.emit("active-speaker:changed", { participant: normalized });
		});

		// Room connected/disconnected
		room.on("status-changed", (status) => {
			if (status === "connected") {
				this.room._emitter.emit("connected", { roomId: room.id });
			} else if (status === "disconnected") {
				this.room._emitter.emit("disconnected", { reason: "connection_lost" });
			}
		});
	}

	/**
	 * Join a room
	 *
	 * @param roomId - Room ID to join
	 * @param options - Join options including userName
	 */
	async join(roomId: string, options: JoinOptions): Promise<void> {
		try {
			// Signal join starting via Effect service
			await this._runtime.runPromise(
				Effect.gen(function* () {
					const roomSvc = yield* RoomService;
					yield* roomSvc.requestJoin(roomId, options);
				}),
			);

			// Actually join via ChalkClient
			const room = await this.client.joinRoom(roomId, {
				displayName: options.userName,
				role: options.role,
				audio: options.audioEnabled,
				video: options.videoEnabled,
				metadata: options.metadata,
			});

			// Attach room to all managers
			this.attachRoomToManagers(room);
		} catch (err) {
			const error = ChalkError.wrap(err);
			const roomError = new RoomError({
				code: "ROOM_NOT_FOUND",
				message: error.message,
				recoverable: false,
			});
			await this._runtime
				.runPromise(
					Effect.gen(function* () {
						const roomSvc = yield* RoomService;
						yield* roomSvc.joinFailed(roomError);
					}),
				)
				.catch(() => {
					// Ignore if join failed operation fails
				});
			throw error;
		}
	}

	/**
	 * Leave the current room
	 *
	 * @param options - Leave options (endForAll for hosts)
	 */
	async leave(options?: LeaveOptions): Promise<void> {
		try {
			await this._runtime.runPromise(
				Effect.gen(function* () {
					const roomSvc = yield* RoomService;
					yield* roomSvc.leave(options);
				}),
			);
			this.client.disconnect();
			this._currentRoom = null;
		} catch (err) {
			const error = ChalkError.wrap(err);
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
		const ctx = wideEvents.start("session.dispose");

		// Dispose Effect services runtime
		this._runtime.dispose();

		// Dispose non-Effect managers
		this.screenShare.dispose();
		this.chat.dispose();
		this.recording.dispose();
		this.interactions.dispose();
		this.ui.dispose();
		this.whiteboard.dispose();

		this.client.disconnect();
		this._currentRoom = null;
		this.removeAllListeners();

		ctx.complete("success");
	}
}
