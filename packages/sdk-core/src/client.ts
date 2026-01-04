/**
 * ChalkClient - Main entry point for the Chalk SDK
 * Integrates with Cloudflare RealtimeKit for WebRTC
 */

import RealtimeKitClient from "@cloudflare/realtimekit";
import { APIClient } from "./api-client.ts";
import { EventEmitter } from "./events.ts";
import { Room } from "./room.ts";
import type {
	ChalkClientConfig,
	ChalkError,
	Participant,
	RoomConfig,
	RoomStatus,
	TokenProvider,
} from "./types.ts";
import { WSClient } from "./ws-client.ts";

interface ChalkClientEvents {
	"token-expired": ChalkError;
}

export class ChalkClient extends EventEmitter<ChalkClientEvents> {
	private readonly apiClient: APIClient;
	private readonly wsUrl?: string;
	private readonly tokenProvider?: TokenProvider;
	private readonly debug: boolean;
	private currentRoom: Room | null = null;
	private currentWsClient: WSClient | null = null;

	constructor(config: ChalkClientConfig) {
		super();
		this.debug = config.debug ?? false;
		this.wsUrl = config.wsUrl;
		this.tokenProvider = config.tokenProvider;

		const hasAuth =
			config.token || config.tokenProvider || config.apiKey || this.debug;
		if (!hasAuth) {
			throw new Error(
				"ChalkClient requires authentication: provide token, tokenProvider, or apiKey",
			);
		}

		this.apiClient = new APIClient(config);

		this.apiClient.on("token-expired", (error) => {
			this.emit("token-expired", error);
		});
	}

	private log(...args: unknown[]): void {
		if (this.debug) {
			console.log("[ChalkClient]", ...args);
		}
	}

	async joinRoom(roomId: string, config: RoomConfig): Promise<Room> {
		if (this.currentRoom) {
			this.log("Leaving existing room before joining new one");
			this.currentRoom.leave();
		}

		this.log("Joining room:", roomId);

		const response = this.debug
			? await this.apiClient.demoJoin(roomId, config.displayName)
			: await this.apiClient.addParticipant(
					roomId,
					config.displayName,
					undefined,
					config.metadata,
				);

		if (!response.success || !response.data) {
			throw new Error(response.error?.message ?? "Failed to join room");
		}

		const { participantId, tokens, room: roomInfo } = response.data;
		this.log("Got auth tokens");

		this.apiClient.setToken(tokens.accessToken);

		const localParticipant: Participant = {
			id: participantId,
			displayName: config.displayName,
			role: "participant",
			isLocal: true,
			videoEnabled: config.video ?? false,
			audioEnabled: config.audio ?? false,
			isSpeaking: false,
			isScreenSharing: false,
			handRaised: false,
			connectionQuality: 100,
			metadata: config.metadata,
		};

		if (this.wsUrl) {
			this.log("Initializing WebSocket signaling");
			const wsClient = new WSClient(this.wsUrl, this.debug, this.tokenProvider);
			// Use the database room ID (UUID) from response, not user-provided name
			const room = new Room(roomInfo.id, wsClient, this.debug);
			room._setLocalParticipant(localParticipant);
			room._setInfo(roomInfo);
			room._setTokens(tokens);

			wsClient.on("token-expired", (error) => {
				this.emit("token-expired", error);
			});

			wsClient.connect(tokens.rtcToken, roomId);

			this.currentWsClient = wsClient;
			this.currentRoom = room;
			return room;
		}

		this.log("Initializing RealtimeKit");
		const rtkClient = await RealtimeKitClient.init({
			authToken: tokens.rtcToken,
			defaults: {
				audio: config.audio ?? false,
				video: config.video ?? false,
			},
		});

		this.log("RealtimeKit initialized, creating Room");

		// Use the database room ID (UUID) from response, not user-provided name
		const room = new Room(roomInfo.id, rtkClient, this.debug);
		room._setLocalParticipant(localParticipant);
		room._setInfo(roomInfo);
		room._setTokens(tokens);

		this.log("Joining RealtimeKit room");
		await rtkClient.join();

		this.currentRoom = room;
		return room;
	}

	/**
	 * Create a new room (requires API key authentication)
	 * @param name - Optional room name
	 * @param config - Optional room configuration
	 * @returns The room ID
	 */
	async createRoom(
		name?: string,
		config?: Record<string, unknown>,
	): Promise<string> {
		this.log("Creating room:", name);

		const response = await this.apiClient.createRoom(name, config);

		if (!response.success || !response.data) {
			throw new Error(response.error?.message ?? "Failed to create room");
		}

		return response.data.roomId;
	}

	/**
	 * End a room (host only)
	 * @param roomId - The room ID to end
	 */
	async endRoom(roomId: string): Promise<void> {
		this.log("Ending room:", roomId);

		const response = await this.apiClient.endRoom(roomId);

		if (!response.success) {
			throw new Error(response.error?.message ?? "Failed to end room");
		}
	}

	/**
	 * Start recording for the current room
	 * @returns The recording ID
	 */
	async startRecording(): Promise<string> {
		if (!this.currentRoom) {
			throw new Error("Not connected to a room");
		}

		const response = await this.apiClient.startRecording(this.currentRoom.id);

		if (!response.success || !response.data) {
			throw new Error(response.error?.message ?? "Failed to start recording");
		}

		return response.data.recordingId;
	}

	/**
	 * Stop recording for the current room
	 */
	async stopRecording(): Promise<void> {
		if (!this.currentRoom) {
			throw new Error("Not connected to a room");
		}

		const response = await this.apiClient.stopRecording(this.currentRoom.id);

		if (!response.success) {
			throw new Error(response.error?.message ?? "Failed to stop recording");
		}
	}

	/**
	 * Get the current room
	 */
	get room(): Room | null {
		return this.currentRoom;
	}

	/**
	 * Check if connected to a room
	 */
	get isConnected(): boolean {
		return this.currentRoom?.status === "connected";
	}

	/**
	 * Get connection status
	 */
	get connectionStatus(): RoomStatus {
		return this.currentRoom?.status ?? "disconnected";
	}

	disconnect(): void {
		if (this.currentRoom) {
			this.log("Disconnecting");
			this.currentRoom.leave();
			this.currentRoom = null;
		}
		if (this.currentWsClient) {
			this.currentWsClient.disconnect();
			this.currentWsClient = null;
		}
	}
}
