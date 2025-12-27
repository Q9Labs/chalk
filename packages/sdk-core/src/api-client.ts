/**
 * HTTP API client for Chalk backend
 */

import type {
	ApiResponse,
	ChalkClientConfig,
	CreateRoomResponse,
	JoinRoomResponse,
	Recording,
	RoomInfo,
} from "./types.ts";

const DEFAULT_API_URL = "http://localhost:8080";

export class APIClient {
	private readonly apiUrl: string;
	private readonly apiKey?: string;
	private token?: string;
	private readonly debug: boolean;

	constructor(config: ChalkClientConfig) {
		this.apiUrl = config.apiUrl ?? DEFAULT_API_URL;
		this.apiKey = config.apiKey;
		this.token = config.token;
		this.debug = config.debug ?? false;
	}

	setToken(token: string): void {
		this.token = token;
	}

	private log(...args: unknown[]): void {
		if (this.debug) {
			console.log("[Chalk API]", ...args);
		}
	}

	private async request<T>(
		method: string,
		path: string,
		body?: unknown,
	): Promise<ApiResponse<T>> {
		const headers: Record<string, string> = {
			"Content-Type": "application/json",
		};

		if (this.token) {
			headers["Authorization"] = `Bearer ${this.token}`;
		} else if (this.apiKey) {
			headers["X-API-Key"] = this.apiKey;
		}

		const url = `${this.apiUrl}${path}`;
		this.log(`${method} ${url}`);

		try {
			const response = await fetch(url, {
				method,
				headers,
				body: body ? JSON.stringify(body) : undefined,
			});

			const data = await response.json();

			if (!response.ok) {
				return {
					success: false,
					error: {
						code: data.code ?? "UNKNOWN_ERROR",
						message: data.message ?? "An unknown error occurred",
						details: data.details,
					},
				};
			}

			return {
				success: true,
				data: data as T,
			};
		} catch (error) {
			this.log("Request failed:", error);
			return {
				success: false,
				error: {
					code: "NETWORK_ERROR",
					message: error instanceof Error ? error.message : "Network error",
				},
			};
		}
	}

	// Room endpoints
	async createRoom(
		name?: string,
		config?: Record<string, unknown>,
	): Promise<ApiResponse<CreateRoomResponse>> {
		return this.request<CreateRoomResponse>("POST", "/api/v1/rooms", {
			name,
			config,
		});
	}

	async getRoom(roomId: string): Promise<ApiResponse<RoomInfo>> {
		return this.request<RoomInfo>("GET", `/api/v1/rooms/${roomId}`);
	}

	async endRoom(roomId: string): Promise<ApiResponse<void>> {
		return this.request<void>("POST", `/api/v1/rooms/${roomId}/end`);
	}

	// Participant endpoints
	async addParticipant(
		roomId: string,
		displayName: string,
		role?: "host" | "participant",
		metadata?: Record<string, unknown>,
	): Promise<ApiResponse<JoinRoomResponse>> {
		return this.request<JoinRoomResponse>(
			"POST",
			`/api/v1/rooms/${roomId}/participants`,
			{
				displayName,
				role,
				metadata,
			},
		);
	}

	// Demo endpoint (no auth required)
	async demoJoin(
		roomId: string,
		displayName: string,
	): Promise<ApiResponse<JoinRoomResponse>> {
		const response = await this.request<{
			success: boolean;
			room_id: string;
			participant_id: string;
			token: string;
			auth_token: string;
			room: { id: string; name: string };
		}>("POST", "/api/v1/demo/join", {
			room_id: roomId,
			display_name: displayName,
		});

		if (!response.success || !response.data) {
			return response as unknown as ApiResponse<JoinRoomResponse>;
		}

		// Transform to JoinRoomResponse format
		return {
			success: true,
			data: {
				participantId: response.data.participant_id,
				token: response.data.auth_token,
				room: {
					id: response.data.room.id,
					name: response.data.room.name,
					status: "connected" as const,
					participantCount: 1,
					config: {},
					createdAt: new Date(),
				},
			},
		};
	}

	async removeParticipant(
		roomId: string,
		participantId: string,
	): Promise<ApiResponse<void>> {
		return this.request<void>(
			"DELETE",
			`/api/v1/rooms/${roomId}/participants/${participantId}`,
		);
	}

	// Recording endpoints
	async startRecording(
		roomId: string,
	): Promise<ApiResponse<{ recordingId: string }>> {
		return this.request<{ recordingId: string }>(
			"POST",
			`/api/v1/rooms/${roomId}/recordings/start`,
		);
	}

	async stopRecording(roomId: string): Promise<ApiResponse<Recording>> {
		return this.request<Recording>(
			"POST",
			`/api/v1/rooms/${roomId}/recordings/stop`,
		);
	}

	async getRecording(recordingId: string): Promise<ApiResponse<Recording>> {
		return this.request<Recording>("GET", `/api/v1/recordings/${recordingId}`);
	}

	async getRecordingDownloadUrl(
		recordingId: string,
	): Promise<ApiResponse<{ url: string }>> {
		return this.request<{ url: string }>(
			"GET",
			`/api/v1/recordings/${recordingId}/download`,
		);
	}
}
