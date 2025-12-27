/**
 * ChalkClient - Main entry point for the Chalk SDK
 * Integrates with Cloudflare RealtimeKit for WebRTC
 */

import RealtimeKitClient from "@cloudflare/realtimekit";
import { APIClient } from "./api-client.ts";
import { Room } from "./room.ts";
import type {
	ChalkClientConfig,
	Participant,
	RoomConfig,
	RoomStatus,
} from "./types.ts";

export class ChalkClient {
	private readonly apiClient: APIClient;
	private readonly debug: boolean;
	private currentRoom: Room | null = null;

	constructor(config: ChalkClientConfig) {
		this.debug = config.debug ?? false;

		if (!config.apiKey && !config.token && !this.debug) {
			throw new Error("ChalkClient requires either apiKey or token");
		}

		this.apiClient = new APIClient(config);
	}

	private log(...args: unknown[]): void {
		if (this.debug) {
			console.log("[ChalkClient]", ...args);
		}
	}

	/**
	 * Join a room using Cloudflare RealtimeKit
	 * @param roomId - The room ID to join
	 * @param config - Room configuration including display name and initial media state
	 * @returns The Room instance
	 */
	async joinRoom(roomId: string, config: RoomConfig): Promise<Room> {
		if (this.currentRoom) {
			this.log("Leaving existing room before joining new one");
			await this.currentRoom.leave();
		}

		this.log("Joining room:", roomId);

		// Get auth token from API (demo endpoint returns Cloudflare auth_token)
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

		const { participantId, token, room: roomInfo } = response.data;
		this.log("Got auth token, initializing RealtimeKit");

		// Store token for future API calls
		this.apiClient.setToken(token);

		// Initialize RealtimeKit with the Cloudflare auth token
		const rtkClient = await RealtimeKitClient.init({
			authToken: token,
			defaults: {
				audio: config.audio ?? false,
				video: config.video ?? false,
			},
		});

		this.log("RealtimeKit initialized, creating Room");

		// Create local participant
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

		// Create Room instance wrapping RealtimeKit
		const room = new Room(roomId, rtkClient, localParticipant, this.debug);
		room._setInfo(roomInfo);

		// Join the RealtimeKit room
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

	/**
	 * Disconnect from the current room
	 */
	disconnect(): void {
		if (this.currentRoom) {
			this.log("Disconnecting");
			this.currentRoom.leave();
			this.currentRoom = null;
		}
	}
}
