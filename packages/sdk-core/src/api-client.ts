/**
 * HTTP API client for Chalk backend
 */

import { EventEmitter } from "./events.ts";
import { camelToSnake, snakeToCamel } from "./transforms.ts";
import { wideEvents } from "./wide-events/index.ts";
import { ChalkError, ChalkErrorCode } from "./errors/chalk-error.ts";
import type {
	ApiResponse,
	ConferenceClientConfig,
	ChalkError as ChalkErrorType,
	CreateJoinTokenResponse,
	CreateRoomOptions,
	CreateRoomResponse,
	ExchangeJoinTokenResponse,
	JoinSessionResponse,
	ListRoomsOptions,
	ListRoomsResponse,
	Recording,
	RoomResource,
	ScheduleRoomOptions,
	TokenProvider,
	TransformedJoinSessionApiResponse,
} from "./types.ts";

interface APIClientEvents {
	"token.expired": ChalkErrorType;
}

export class APIClient extends EventEmitter<APIClientEvents> {
	private readonly apiUrl: string;
	private readonly apiKey?: string;
	private readonly tokenProvider?: TokenProvider;
	private token?: string;
	private isRefreshingToken = false;
	// SDKCORE-MED-02: Queue for serializing concurrent refresh requests
	private refreshPromise: Promise<string | null> | null = null;

	constructor(config: ConferenceClientConfig) {
		super();
		if (!config.apiUrl) {
			throw new Error("apiUrl is required in ConferenceClientConfig");
		}
		this.apiUrl = config.apiUrl;
		this.apiKey = config.apiKey;
		this.tokenProvider = config.tokenProvider;
		this.token = config.token;
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
		options?: { skipAuth?: boolean },
	): Promise<ApiResponse<T>> {
		const ctx = wideEvents.start("api.request");
		ctx.set("request", { method, path, hasBody: !!body });

		const headers: Record<string, string> = {
			"Content-Type": "application/json",
		};

		// Only call tokenProvider if we don't have a token yet
		// tokenProvider is for REFRESH, not initial token acquisition
		// The token is set via setToken() after join
		if (!options?.skipAuth && !this.token && this.tokenProvider && !isRetry) {
			try {
				const newToken = await this.tokenProvider();
				// Only use the token if it's non-empty
				if (newToken) {
					this.token = newToken;
				}
			} catch (error) {
				ctx.complete("error", {
					code: "TOKEN_EXPIRED",
					message: error instanceof Error ? error.message : "Failed to get authentication token",
				});
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

		if (!options?.skipAuth) {
			if (this.token) {
				headers["Authorization"] = `Bearer ${this.token}`;
			} else if (this.apiKey) {
				headers["X-API-Key"] = this.apiKey;
			}
		}

		const url = `${this.apiUrl}${path}`;

		try {
			const transformedBody = body ? camelToSnake(body) : undefined;

			const response = await fetch(url, {
				method,
				headers,
				body: transformedBody ? JSON.stringify(transformedBody) : undefined,
			});
			const responseMeta = {
				statusCode: response.status,
				requestId: response.headers.get("x-request-id"),
				traceId: response.headers.get("x-chalk-trace-id"),
				cfRay: response.headers.get("cf-ray"),
			};

			if (response.status === 401 && !isRetry && !options?.skipAuth) {
				ctx.set("response", responseMeta);
				ctx.complete("error", { code: "HTTP_401", message: "Unauthorized - attempting refresh" });
				return this.handle401<T>(method, path, body, options);
			}

			// SDKCORE-MED-01: Handle empty/204 responses before parsing JSON
			if (response.status === 204 || response.headers.get("content-length") === "0") {
				ctx.set("response", responseMeta);
				ctx.complete("success");
				return {
					success: true,
					data: undefined as T,
				};
			}

			const contentType = response.headers.get("content-type") ?? "";
			const rawText = await response.text();
			let rawData: unknown = undefined;

			if (rawText) {
				if (contentType.includes("application/json")) {
					rawData = JSON.parse(rawText);
				} else {
					try {
						rawData = JSON.parse(rawText);
					} catch {
						rawData = rawText;
					}
				}
			}

			const data =
				rawData && typeof rawData === "object"
					? snakeToCamel<T>(rawData as T)
					: (undefined as T | undefined);

			if (!response.ok) {
				const errorData =
					rawData && typeof rawData === "object"
						? (rawData as {
								code?: string;
								message?: string;
								error?: string;
								details?: Record<string, unknown>;
							})
						: undefined;
				const fallbackMessage = rawText.trim() || `Request failed with status ${response.status}`;
				const errorMessage =
					errorData?.message ?? errorData?.error ?? fallbackMessage;
				const errorCode = errorData?.code ?? `HTTP_${response.status}`;
				ctx.set("response", responseMeta);
				ctx.complete("error", { code: errorCode, message: errorMessage });
				return {
					success: false,
					error: {
						code: errorCode,
						message: errorMessage,
						details: errorData?.details,
					},
				};
			}

			ctx.set("response", responseMeta);
			ctx.complete("success");
			return {
				success: true,
				data,
			};
		} catch (error) {
			ctx.complete("error", {
				code: "NETWORK_ERROR",
				message: error instanceof Error ? error.message : "Network error",
			});
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
		options?: { skipAuth?: boolean },
	): Promise<ApiResponse<T>> {
		if (!this.tokenProvider) {
			const error: ChalkErrorType = {
				code: "TOKEN_EXPIRED",
				message: "Authentication token expired. No tokenProvider configured.",
			};
			this.emit("token.expired", error);
			return { success: false, error };
		}

		// SDKCORE-MED-02: Serialize concurrent refresh requests
		// If a refresh is already in progress, wait for it instead of failing
		if (this.isRefreshingToken && this.refreshPromise) {
			const token = await this.refreshPromise;
			if (token) {
				return this.request<T>(method, path, body, true, options);
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
			const error: ChalkErrorType = {
				code: "TOKEN_EXPIRED",
				message: "Token refresh failed: no token returned",
			};
			this.emit("token.expired", error);
			return { success: false, error };
		}

		return this.request<T>(method, path, body, true, options);
	}

	// ConferenceSession endpoints
	async createRoom(
		options: CreateRoomOptions = {},
	): Promise<ApiResponse<RoomResource>> {
		const response = await this.request<RoomResource>("POST", "/api/v1/rooms", {
			name: options.name,
			config: options.config,
		});

		if (!response.success || !response.data) {
			return response;
		}

		return {
			success: true,
			data: this.normalizeRoomResource(response.data),
		};
	}

	async scheduleRoom(
		options: ScheduleRoomOptions,
	): Promise<ApiResponse<RoomResource>> {
		const response = await this.request<RoomResource>(
			"POST",
			"/api/v1/rooms/schedule",
			{
				name: options.name,
				config: options.config,
				scheduledStartAt:
					options.scheduledStartAt instanceof Date
						? options.scheduledStartAt.toISOString()
						: options.scheduledStartAt,
				scheduledEndAt:
					options.scheduledEndAt instanceof Date
						? options.scheduledEndAt.toISOString()
						: options.scheduledEndAt,
				allowEarlyJoinMinutes: options.allowEarlyJoinMinutes,
			},
		);

		if (!response.success || !response.data) {
			return response;
		}

		return {
			success: true,
			data: this.normalizeRoomResource(response.data),
		};
	}

	async createSession(
		name?: string,
		config?: Record<string, unknown>,
	): Promise<ApiResponse<CreateRoomResponse>> {
		const response = await this.createRoom({ name, config });
		if (!response.success || !response.data) {
			return response as unknown as ApiResponse<CreateRoomResponse>;
		}

		return {
			success: true,
			data: {
				...response.data,
				id: response.data.id,
				roomId: response.data.id,
			},
		};
	}

	async getRoom(roomId: string): Promise<ApiResponse<RoomResource>> {
		const response = await this.request<RoomResource>("GET", `/api/v1/rooms/${roomId}`);
		if (!response.success || !response.data) {
			return response;
		}

		return {
			success: true,
			data: this.normalizeRoomResource(response.data),
		};
	}

	async listRooms(options: ListRoomsOptions = {}): Promise<ApiResponse<ListRoomsResponse>> {
		const params = new URLSearchParams();
		if (typeof options.limit === "number") {
			params.set("limit", String(options.limit));
		}
		if (typeof options.offset === "number") {
			params.set("offset", String(options.offset));
		}
		if (options.status?.length) {
			params.set("status", options.status.join(","));
		}
		const query = params.toString();
		const path = query ? `/api/v1/rooms?${query}` : "/api/v1/rooms";

		const response = await this.request<ListRoomsResponse>("GET", path);
		if (!response.success || !response.data) {
			return response;
		}

		return {
			success: true,
			data: {
				...response.data,
				rooms: response.data.rooms.map((room) => this.normalizeRoomResource(room)),
			},
		};
	}

	async createJoinToken(roomId: string): Promise<ApiResponse<CreateJoinTokenResponse>> {
		return this.request<CreateJoinTokenResponse>("POST", `/api/v1/rooms/${roomId}/join-token`);
	}

	async exchangeJoinToken(joinToken: string): Promise<ApiResponse<ExchangeJoinTokenResponse>> {
		return this.request<ExchangeJoinTokenResponse>(
			"POST",
			"/api/v1/public/join-token/exchange",
			{ joinToken },
			false,
			{ skipAuth: true },
		);
	}

	async endSession(roomId: string): Promise<ApiResponse<void>> {
		return this.request<void>("POST", `/api/v1/rooms/${roomId}/end`);
	}

	async addParticipant(
		roomId: string,
		displayName: string,
		role?: "host" | "participant",
		metadata?: Record<string, unknown>,
	): Promise<ApiResponse<JoinSessionResponse>> {
		const response = await this.request<TransformedJoinSessionApiResponse>(
			"POST",
			`/api/v1/rooms/${roomId}/participants`,
			{
				displayName,
				role,
				metadata,
			},
		);

		if (!response.success || !response.data) {
			return response as unknown as ApiResponse<JoinSessionResponse>;
		}

		return {
			success: true,
			data: this.transformJoinResponse(response.data),
		};
	}

	async demoJoin(
		roomId: string,
		displayName: string,
	): Promise<ApiResponse<JoinSessionResponse>> {
		const response = await this.request<TransformedJoinSessionApiResponse>(
			"POST",
			"/api/v1/demo/join",
			{
				roomId,
				displayName,
			},
		);

		if (!response.success || !response.data) {
			return response as unknown as ApiResponse<JoinSessionResponse>;
		}

		return {
			success: true,
			data: this.transformJoinResponse(response.data),
		};
	}

	private transformJoinResponse(
		data: TransformedJoinSessionApiResponse,
	): JoinSessionResponse {
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
			roomCreated: data.roomCreated,
			tenantConfig: data.tenantConfig,
			shouldStartRecording: data.shouldStartRecording,
		};
	}

	private normalizeRoomResource(
		data: RoomResource & Partial<CreateRoomResponse>,
	): RoomResource {
		const id = data.id ?? data.roomId;
		if (!id) {
			throw new ChalkError(
				ChalkErrorCode.INVALID_PARAMS,
				"Missing room ID in room response",
			);
		}

		return {
			...data,
			id,
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

	async updateParticipant(
		roomId: string,
		participantId: string,
		data: { displayName?: string; role?: string },
	): Promise<ApiResponse<RoomResource["activeParticipantCount"]>> {
		return this.request<RoomResource["activeParticipantCount"]>(
			"PATCH",
			`/api/v1/rooms/${roomId}/participants/${participantId}`,
			data,
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

	// Whiteboard file presign (R2)
	async presignWhiteboardUpload(
		roomId: string,
		fileId: string,
		mimeType: string,
	): Promise<ApiResponse<{ uploadUrl: string; expiresAtMs: number }>> {
		return this.request<{ uploadUrl: string; expiresAtMs: number }>(
			"POST",
			`/api/v1/rooms/${roomId}/whiteboard/files/presign-upload`,
			{ fileId, mimeType },
		);
	}

	async presignWhiteboardDownload(
		roomId: string,
		fileId: string,
	): Promise<ApiResponse<{ downloadUrl: string; expiresAtMs: number }>> {
		return this.request<{ downloadUrl: string; expiresAtMs: number }>(
			"POST",
			`/api/v1/rooms/${roomId}/whiteboard/files/presign-download`,
			{ fileId },
		);
	}

	async presignChatAttachmentsUpload(
		roomId: string,
		files: Array<{ fileName: string; mimeType: string; sizeBytes: number }>,
	): Promise<
		ApiResponse<{
			files: Array<{
				attachmentId: string;
				uploadUrl: string;
				expiresAtMs: number;
				fileName: string;
				mimeType: string;
				sizeBytes: number;
				kind: "image" | "document" | "file";
			}>;
		}>
	> {
		return this.request<{
			files: Array<{
				attachmentId: string;
				uploadUrl: string;
				expiresAtMs: number;
				fileName: string;
				mimeType: string;
				sizeBytes: number;
				kind: "image" | "document" | "file";
			}>;
		}>(
			"POST",
			`/api/v1/rooms/${roomId}/chat/attachments/presign-upload`,
			{ files },
		);
	}

	async presignChatAttachmentDownload(
		roomId: string,
		attachmentId: string,
	): Promise<ApiResponse<{ downloadUrl: string; expiresAtMs: number }>> {
		return this.request<{ downloadUrl: string; expiresAtMs: number }>(
			"POST",
			`/api/v1/rooms/${roomId}/chat/attachments/presign-download`,
			{ attachmentId },
		);
	}

	async uploadChatAttachment(
		roomId: string,
		attachmentId: string,
		file: File,
	): Promise<ApiResponse<void>> {
		const ctx = wideEvents.start("api.request");
		ctx.set("request", {
			method: "POST",
			path: `/api/v1/rooms/${roomId}/chat/attachments/upload`,
			hasBody: true,
		});

		const headers: Record<string, string> = {};
		if (this.token) {
			headers["Authorization"] = `Bearer ${this.token}`;
		} else if (this.apiKey) {
			headers["X-API-Key"] = this.apiKey;
		}

		const formData = new FormData();
		formData.append("attachment_id", attachmentId);
		formData.append("file", file);

		try {
			const response = await fetch(`${this.apiUrl}/api/v1/rooms/${roomId}/chat/attachments/upload`, {
				method: "POST",
				headers,
				body: formData,
			});
			const responseMeta = {
				statusCode: response.status,
				requestId: response.headers.get("x-request-id"),
				traceId: response.headers.get("x-chalk-trace-id"),
				cfRay: response.headers.get("cf-ray"),
			};

			if (response.ok) {
				ctx.set("response", responseMeta);
				ctx.complete("success");
				return { success: true, data: undefined };
			}

			const rawText = await response.text();
			let errorMessage = rawText.trim() || `Request failed with status ${response.status}`;
			try {
				const parsed = JSON.parse(rawText) as { message?: string; error?: string };
				errorMessage = parsed.message ?? parsed.error ?? errorMessage;
			} catch {
				// plain text fallback
			}

			ctx.set("response", responseMeta);
			ctx.complete("error", { code: `HTTP_${response.status}`, message: errorMessage });
			return {
				success: false,
				error: {
					code: `HTTP_${response.status}`,
					message: errorMessage,
				},
			};
		} catch (error) {
			ctx.complete("error", {
				code: "NETWORK_ERROR",
				message: error instanceof Error ? error.message : "Network error",
			});
			return {
				success: false,
				error: {
					code: "NETWORK_ERROR",
					message: error instanceof Error ? error.message : "Network error",
				},
			};
		}
	}
}
