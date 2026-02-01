/**
 * ChalkLogger - Wide-event logging system for React Native SDK
 *
 * Emits structured, context-rich events following canonical log line best practices.
 * Single event per operation with high cardinality (user/room IDs) and
 * high dimensionality (many fields).
 */

import { NativeModules, Platform } from "react-native";

// SDK version from package.json (injected at build time or hardcoded)
const SDK_VERSION = "0.0.50";

// Detect iOS simulator
const isIOSSimulator =
	Platform.OS === "ios" &&
	((Platform.constants as Record<string, unknown>)?.isTesting === true ||
		(NativeModules.PlatformConstants as Record<string, unknown>)
			?.isSimulator === true ||
		__DEV__);

// Generate unique session ID
function generateSessionId(): string {
	const timestamp = Date.now().toString(36);
	const random = Math.random().toString(36).substring(2, 8);
	return `rn_${timestamp}_${random}`;
}

// Environment context (auto-injected into every event)
function getEnvContext() {
	return {
		platform: Platform.OS as "ios" | "android",
		platformVersion: String(Platform.Version),
		sdkVersion: SDK_VERSION,
		isSimulator: Platform.OS === "ios" ? isIOSSimulator : false,
		debug: __DEV__,
	};
}

// Session context (can be updated as user joins rooms)
interface SessionContext {
	roomId?: string;
	participantId?: string;
	displayName?: string;
}

// Wide event structure
interface WideEvent {
	event: string;
	[key: string]: unknown;
}

// Full log entry (internal)
interface LogEntry {
	timestamp: string;
	level: "info" | "error";
	event: string;
	sessionId: string;
	env: ReturnType<typeof getEnvContext>;
	[key: string]: unknown;
}

class ChalkLoggerImpl {
	private sessionId: string;
	private sessionContext: SessionContext = {};
	private debugEnabled = __DEV__;

	constructor() {
		this.sessionId = generateSessionId();
	}

	/**
	 * Enable or disable debug logging
	 */
	setDebug(enabled: boolean): void {
		this.debugEnabled = enabled;
	}

	/**
	 * Update session context (called when joining a room)
	 */
	setSessionContext(ctx: SessionContext): void {
		this.sessionContext = { ...this.sessionContext, ...ctx };
	}

	/**
	 * Clear session context (called when leaving a room)
	 */
	clearSessionContext(): void {
		this.sessionContext = {};
	}

	/**
	 * Get current session ID
	 */
	getSessionId(): string {
		return this.sessionId;
	}

	/**
	 * Log an info-level wide event
	 */
	info(event: WideEvent): void {
		if (!this.debugEnabled) return;
		this.emit("info", event);
	}

	/**
	 * Log an error-level wide event
	 */
	error(event: WideEvent): void {
		// Always log errors, even when debug is disabled
		this.emit("error", event);
	}

	private emit(level: "info" | "error", event: WideEvent): void {
		const { event: eventName, ...rest } = event;

		const entry: LogEntry = {
			timestamp: new Date().toISOString(),
			level,
			event: eventName,
			sessionId: this.sessionId,
			env: getEnvContext(),
			...this.sessionContext,
			...rest,
		};

		// Output as JSON to console
		const output = JSON.stringify(entry);
		if (level === "error") {
			console.error(`[Chalk] ${output}`);
		} else {
			console.log(`[Chalk] ${output}`);
		}
	}
}

// Singleton instance
export const logger = new ChalkLoggerImpl();

// Factory for creating configured loggers (if needed for testing)
export function createLogger(config?: { debug?: boolean }) {
	const instance = new ChalkLoggerImpl();
	if (config?.debug !== undefined) {
		instance.setDebug(config.debug);
	}
	return instance;
}

// Export type for external use
export type ChalkLogger = ChalkLoggerImpl;
