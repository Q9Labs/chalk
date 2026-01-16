/**
 * HTTP API client for Chalk backend
 */

import { EventEmitter } from "./events.ts";
import { camelToSnake, snakeToCamel } from "./transforms.ts";
import { createLogger, type Logger } from "./utils/logger.ts";
import { ChalkError, ChalkErrorCode } from "./errors/chalk-error.ts";
import type {
	ApiResponse,
	ChalkClientConfig,
	ChalkError as ChalkErrorType,
	CreateRoomResponse,
	JoinRoomResponse,
	Recording,
	RoomInfo,
	TokenProvider,
	TransformedJoinRoomApiResponse,
} from "./types.ts";

interface APIClientEvents {
	"token-expired": ChalkErrorType;
}

export class APIClient extends EventEmitter<APIClientEvents> {
	private readonly apiUrl: string;
	private readonly apiKey?: string;
	private readonly tokenProvider?: TokenProvider;
	private token?: string;
	private isRefreshingToken = false;
	// SDKCORE-MED-02: Queue for serializing concurrent refresh requests
	private refreshPromise: Promise<string | null> | null = null;
	private readonly log: Logger = createLogger("API");

	constructor(config: ChalkClientConfig) {
		super();
		if (!config.apiUrl) {
			throw new Error("apiUrl is required in ChalkClientConfig");
		}
		this.apiUrl = config.apiUrl;
		this.apiKey = config.apiKey;
		this.tokenProvider = config.tokenProvider;
		this.token = config.token;

		if (config.apiKey) {
			this.log.warn(
				"Using apiKey is deprecated and will be removed in v2.0. Use `token` or `tokenProvider` instead for improved security.",
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


	private async request<T>(
		method: string,
		path: string,
		body?: unknown,
		isRetry = false,
	): Promise<ApiResponse<T>> {
		const headers: Record<string, string> = {
			"Content-Type": "application/json",
		};

		// Only call tokenProvider if we don't have a token yet
		// tokenProvider is for REFRESH, not initial token acquisition
		// The token is set via setToken() after join
		if (!this.token && this.tokenProvider && !isRetry) {
			try {
				const newToken = await this.tokenProvider();
				// Only use the token if it's non-empty
				if (newToken) {
					this.token = newToken;
				}
			} catch (error) {
				this.log.error("Token provider failed", { error });
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
		this.log.debug("Request", { method, url });

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

			// SDKCORE-MED-01: Handle empty/204 responses before parsing JSON
			if (response.status === 204 || response.headers.get("content-length") === "0") {
				return {
					success: true,
					data: undefined as T,
				};
			}

			const rawData = await response.json();
			const data = snakeToCamel<T>(rawData);

			if (!response.ok) {
				const errorData = rawData as {
					code?: string;
					message?: string;
					error?: string; // Go API returns "error" field
					details?: Record<string, unknown>;
				};
				const errorMessage =
					errorData.message ?? errorData.error ?? "An unknown error occurred";
				this.log.error("API error", { status: response.status, message: errorMessage });
				return {
					success: false,
					error: {
						code: errorData.code ?? `HTTP_${response.status}`,
						message: errorMessage,
						details: errorData.details,
					},
				};
			}

			return {
				success: true,
				data,
			};
		} catch (error) {
			this.log.error("Request failed", { error });
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
		this.log.debug("Received 401, attempting token refresh");

		if (!this.tokenProvider) {
			const error: ChalkErrorType = {
				code: "TOKEN_EXPIRED",
				message: "Authentication token expired. No tokenProvider configured.",
			};
			this.emit("token-expired", error);
			return { success: false, error };
		}

		// SDKCORE-MED-02: Serialize concurrent refresh requests
		// If a refresh is already in progress, wait for it instead of failing
		if (this.isRefreshingToken && this.refreshPromise) {
			this.log.debug("Waiting for existing token refresh");
			const token = await this.refreshPromise;
			if (token) {
				return this.request<T>(method, path, body, true);
			}
			return {
				success: false,
				error: {
					code: "TOKEN_EXPIRED",
					message: "Token refresh failed",
				},
			};
		}

		this.isRefreshingToken = true;

		// Create a promise that other concurrent requests can await
		this.refreshPromise = (async (): Promise<string | null> => {
			try {
				const newToken = await this.tokenProvider!();
				if (!newToken) {
					return null;
				}
				this.token = newToken;
				return newToken;
			} catch {
				return null;
			} finally {
				this.isRefreshingToken = false;
				this.refreshPromise = null;
			}
		})();

		const newToken = await this.refreshPromise;

		// Only proceed if we got a valid token
		if (!newToken) {
			this.log.warn("Token refresh returned empty token");
			const error: ChalkErrorType = {
				code: "TOKEN_EXPIRED",
				message: "Token refresh failed: no token returned",
			};
			this.emit("token-expired", error);
			return { success: false, error };
		}

		this.log.debug("Token refreshed successfully");
		return this.request<T>(method, path, body, true);
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
		// SDKCORE-HIGH-01: Remove authToken fallback - authToken is RTC-only
		// Demo mode returns 'token', standard mode returns 'accessToken'
		const accessToken = data.token ?? data.accessToken;
		if (!accessToken) {
			throw new ChalkError(
				ChalkErrorCode.AUTH_FAILED,
				"Missing access token in join response - server did not provide valid authentication",
			);
		}

		return {
			participantId: data.participantId,
			role: data.role ?? "participant",
			tokens: {
				accessToken,
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
		this.log.debug("removeParticipant", { roomId, participantId });
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
