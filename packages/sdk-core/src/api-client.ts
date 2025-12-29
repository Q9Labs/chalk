/**
 * HTTP API client for Chalk backend
 */

import { EventEmitter } from "./events.ts";
import { camelToSnake, snakeToCamel } from "./transforms.ts";
import type {
	ApiResponse,
	ChalkClientConfig,
	ChalkError,
	CreateRoomResponse,
	JoinRoomResponse,
	Recording,
	RoomInfo,
	TokenProvider,
	TransformedJoinRoomApiResponse,
} from "./types.ts";

const DEFAULT_API_URL = "http://localhost:8080";

interface APIClientEvents {
	"token-expired": ChalkError;
}

export class APIClient extends EventEmitter<APIClientEvents> {
	private readonly apiUrl: string;
	private readonly apiKey?: string;
	private readonly tokenProvider?: TokenProvider;
	private token?: string;
	private readonly debug: boolean;
	private isRefreshingToken = false;

	constructor(config: ChalkClientConfig) {
		super();
		this.apiUrl = config.apiUrl ?? DEFAULT_API_URL;
		this.apiKey = config.apiKey;
		this.tokenProvider = config.tokenProvider;
		this.token = config.token;
		this.debug = config.debug ?? false;

		if (config.apiKey) {
			console.warn(
				"[Chalk] DEPRECATION WARNING: Using apiKey is deprecated and will be removed in v2.0. " +
					"Use `token` or `tokenProvider` instead for improved security.",
			);
		}
	}

	setToken(token: string): void {
		this.token = token;
	}

	async getToken(): Promise<string | undefined> {
		if (this.tokenProvider) {
			this.token = await this.tokenProvider();
		}
		return this.token;
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
		isRetry = false,
	): Promise<ApiResponse<T>> {
		const headers: Record<string, string> = {
			"Content-Type": "application/json",
		};

		if (this.tokenProvider && !isRetry) {
			try {
				this.token = await this.tokenProvider();
			} catch (error) {
				this.log("Token provider failed:", error);
				return {
					success: false,
					error: {
						code: "TOKEN_EXPIRED",
						message:
							error instanceof Error
								? error.message
								: "Failed to get authentication token",
					},
				};
			}
		}

		if (this.token) {
			headers["Authorization"] = `Bearer ${this.token}`;
		} else if (this.apiKey) {
			headers["X-API-Key"] = this.apiKey;
		}

		const url = `${this.apiUrl}${path}`;
		this.log(`${method} ${url}`);

		try {
			const transformedBody = body ? camelToSnake(body) : undefined;

			const response = await fetch(url, {
				method,
				headers,
				body: transformedBody ? JSON.stringify(transformedBody) : undefined,
			});

			if (response.status === 401 && !isRetry) {
				return this.handle401<T>(method, path, body);
			}

			const rawData = await response.json();
			const data = snakeToCamel<T>(rawData);

			if (!response.ok) {
				const errorData = rawData as {
					code?: string;
					message?: string;
					details?: Record<string, unknown>;
				};
				return {
					success: false,
					error: {
						code: errorData.code ?? "UNKNOWN_ERROR",
						message: errorData.message ?? "An unknown error occurred",
						details: errorData.details,
					},
				};
			}

			return {
				success: true,
				data,
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

	private async handle401<T>(
		method: string,
		path: string,
		body?: unknown,
	): Promise<ApiResponse<T>> {
		this.log("Received 401, attempting token refresh");

		if (!this.tokenProvider) {
			const error: ChalkError = {
				code: "TOKEN_EXPIRED",
				message: "Authentication token expired. No tokenProvider configured.",
			};
			this.emit("token-expired", error);
			return { success: false, error };
		}

		if (this.isRefreshingToken) {
			return {
				success: false,
				error: {
					code: "TOKEN_EXPIRED",
					message: "Token refresh already in progress",
				},
			};
		}

		this.isRefreshingToken = true;

		try {
			this.token = await this.tokenProvider();
			this.log("Token refreshed successfully");
			return this.request<T>(method, path, body, true);
		} catch (error) {
			this.log("Token refresh failed:", error);
			const chalkError: ChalkError = {
				code: "TOKEN_EXPIRED",
				message:
					error instanceof Error
						? error.message
						: "Failed to refresh authentication token",
			};
			this.emit("token-expired", chalkError);
			return { success: false, error: chalkError };
		} finally {
			this.isRefreshingToken = false;
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

	async addParticipant(
		roomId: string,
		displayName: string,
		role?: "host" | "participant",
		metadata?: Record<string, unknown>,
	): Promise<ApiResponse<JoinRoomResponse>> {
		const response = await this.request<TransformedJoinRoomApiResponse>(
			"POST",
			`/api/v1/rooms/${roomId}/participants`,
			{
				displayName,
				role,
				metadata,
			},
		);

		if (!response.success || !response.data) {
			return response as unknown as ApiResponse<JoinRoomResponse>;
		}

		return {
			success: true,
			data: this.transformJoinResponse(response.data),
		};
	}

	async demoJoin(
		roomId: string,
		displayName: string,
	): Promise<ApiResponse<JoinRoomResponse>> {
		const response = await this.request<TransformedJoinRoomApiResponse>(
			"POST",
			"/api/v1/demo/join",
			{
				roomId,
				displayName,
			},
		);

		if (!response.success || !response.data) {
			return response as unknown as ApiResponse<JoinRoomResponse>;
		}

		return {
			success: true,
			data: this.transformJoinResponse(response.data),
		};
	}

	private transformJoinResponse(
		data: TransformedJoinRoomApiResponse,
	): JoinRoomResponse {
		return {
			participantId: data.participantId,
			tokens: {
				accessToken: data.accessToken ?? data.authToken,
				refreshToken: data.refreshToken,
				rtcToken: data.authToken,
				expiresAt: data.expiresAt,
			},
			room: {
				id: data.room.id,
				name: data.room.name,
				status: "connected" as const,
				participantCount: 1,
				config: {},
				createdAt: new Date(),
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
