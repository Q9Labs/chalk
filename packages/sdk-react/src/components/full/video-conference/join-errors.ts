import type { ChalkError } from "@q9labs/chalk-core";
import { ChalkErrorCode } from "@q9labs/chalk-core";

const NON_RETRYABLE_JOIN_CODES = new Set([
	"ALREADY_IN_ROOM",
	"PERMISSION_DENIED",
	"ROOM_NOT_FOUND",
	"ROOM_FULL",
	"ROOM_ENDED",
	"INVALID_API_KEY",
	"INVALID_REQUEST",
]);

export type JoinFailureStage =
	| "join_api"
	| "auth_refresh"
	| "rtc_join"
	| "ws_connect"
	| "join_unknown";

export const inferJoinFailureStage = (error: ChalkError): JoinFailureStage => {
	const code = String(error.code ?? "").toUpperCase();
	const message = (error.message ?? "").toLowerCase();

	if (
		code === "TOKEN_EXPIRED" ||
		code === "AUTH_FAILED" ||
		message.includes("token refresh")
	) {
		return "auth_refresh";
	}

	if (
		code.startsWith("WS_") ||
		code === "MAX_RECONNECT_ATTEMPTS" ||
		code === "WEBSOCKET_ERROR" ||
		message.includes("websocket")
	) {
		return "ws_connect";
	}

	if (
		message.includes("realtimekit") ||
		message.includes("roomsockethandlejoinroom failed") ||
		message.includes("failed to join room after")
	) {
		return "rtc_join";
	}

	if (
		message.includes("failed to fetch") ||
		message.includes("network") ||
		message.includes("status code") ||
		message.includes("/participants") ||
		code === "RATE_LIMITED"
	) {
		return "join_api";
	}

	return "join_unknown";
};

export const isTransientJoinFailure = (
	error: ChalkError,
	stage: JoinFailureStage,
): boolean => {
	const code = String(error.code ?? "").toUpperCase();
	if (NON_RETRYABLE_JOIN_CODES.has(code)) return false;
	if (stage === "auth_refresh" || stage === "rtc_join" || stage === "ws_connect") {
		return true;
	}
	const message = (error.message ?? "").toLowerCase();
	return (
		message.includes("failed to fetch") ||
		message.includes("network") ||
		message.includes("timeout") ||
		message.includes("temporarily") ||
		code === "CONNECTION_FAILED" ||
		code === "RECONNECT_FAILED" ||
		code === "TOKEN_EXPIRED" ||
		code === "AUTH_FAILED" ||
		code === "RATE_LIMITED"
	);
};

export const toChalkError = (error: unknown): ChalkError => {
	if (typeof error === "object" && error !== null) {
		const candidate = error as {
			code?: unknown;
			message?: unknown;
			details?: Record<string, unknown>;
		};
		return {
			code:
				typeof candidate.code === "string"
					? candidate.code
					: ChalkErrorCode.UNKNOWN_ERROR,
			message:
				typeof candidate.message === "string"
					? candidate.message
					: "Unexpected error",
			details: candidate.details,
		};
	}

	return {
		code: ChalkErrorCode.UNKNOWN_ERROR,
		message:
			error instanceof Error
				? error.message
				: typeof error === "string"
					? error
					: "Unexpected error",
	};
};

export const waitMs = (ms: number): Promise<void> =>
	new Promise((resolve) => window.setTimeout(resolve, ms));
