export const RECONNECT_DELAYS_MS = [1000, 2000, 4000, 8000, 16000] as const;

export const HEARTBEAT_INTERVAL_MS = 30_000;
// SDKCORE-LOW-01: Timeout threshold (2 missed pongs = timeout)
export const HEARTBEAT_TIMEOUT_MS = HEARTBEAT_INTERVAL_MS * 2.5;

export const connectionStates = [
	"disconnected",
	"connecting",
	"connected",
	"reconnecting",
	"failed",
] as const;

export type ConnectionState = (typeof connectionStates)[number];

export const closeCodeMap: Record<number, string> = {
	1000: "Normal closure",
	1001: "Going away (page navigation or server shutdown)",
	1002: "Protocol error",
	1003: "Unsupported data type",
	1005: "No status received (abnormal closure)",
	1006: "Abnormal closure (connection lost without close frame)",
	1007: "Invalid frame payload data",
	1008: "Policy violation",
	1009: "Message too big",
	1010: "Missing expected extension",
	1011: "Internal server error",
	1012: "Service restart",
	1013: "Try again later",
	1014: "Bad gateway",
	1015: "TLS handshake failure",
};

