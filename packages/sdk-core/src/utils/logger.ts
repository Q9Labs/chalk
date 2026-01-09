/**
 * Debug logger for Chalk SDK
 * Human-readable, glanceable logging with essential data only
 *
 * @packageDocumentation
 * @module @q9labs/chalk-core/utils/logger
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

/** Logger configuration */
export interface LoggerConfig {
	/** Enable/disable all logging */
	enabled: boolean;
	/** Minimum log level to display */
	level?: LogLevel;
	/** Custom log handler (for testing or custom outputs) */
	handler?: (entry: LogEntry) => void;
}

/** Structured log entry */
export interface LogEntry {
	timestamp: number;
	level: LogLevel;
	component: string;
	message: string;
	data?: Record<string, unknown>;
}

/** Visual prefixes for quick scanning */
const LEVEL_PREFIX: Record<LogLevel, string> = {
	debug: "·",
	info: "→",
	warn: "⚠",
	error: "✗",
};

/** Colors for browser console */
const LEVEL_COLOR: Record<LogLevel, string> = {
	debug: "#888",
	info: "#0af",
	warn: "#fa0",
	error: "#f44",
};

const LEVEL_PRIORITY: Record<LogLevel, number> = {
	debug: 0,
	info: 1,
	warn: 2,
	error: 3,
};

/** Global logger state */
let globalConfig: LoggerConfig = {
	enabled: false,
	level: "debug",
};

/** Set global logger config */
export function configureLogger(config: Partial<LoggerConfig>): void {
	globalConfig = { ...globalConfig, ...config };
}

/** Check if logging is enabled */
export function isLoggingEnabled(): boolean {
	return globalConfig.enabled;
}

/**
 * Format data for logging - extracts essential fields only
 */
function formatData(data: unknown): Record<string, unknown> | undefined {
	if (!data) return undefined;
	if (typeof data !== "object") return { value: data };

	const obj = data as Record<string, unknown>;
	const result: Record<string, unknown> = {};

	// Essential fields to always include
	const essentialKeys = [
		"id",
		"roomId",
		"participantId",
		"userId",
		"displayName",
		"status",
		"type",
		"kind",
		"reason",
		"code",
		"message",
		"enabled",
		"muted",
		"count",
		"action",
		"emoji",
		"trackId",
		"deviceId",
	];

	for (const key of essentialKeys) {
		if (key in obj && obj[key] !== undefined) {
			result[key] = obj[key];
		}
	}

	// If no essential keys found, show first few keys
	if (Object.keys(result).length === 0) {
		const keys = Object.keys(obj).slice(0, 4);
		for (const key of keys) {
			const val = obj[key];
			// Skip functions and complex objects
			if (typeof val === "function") continue;
			if (val && typeof val === "object" && !Array.isArray(val)) {
				result[key] = "[object]";
			} else if (Array.isArray(val)) {
				result[key] = `[${val.length}]`;
			} else {
				result[key] = val;
			}
		}
	}

	return Object.keys(result).length > 0 ? result : undefined;
}

/**
 * Format log entry for console output
 */
function formatLogLine(entry: LogEntry): string {
	const prefix = LEVEL_PREFIX[entry.level];
	const time = new Date(entry.timestamp).toISOString().slice(11, 23);
	const dataStr = entry.data ? ` ${JSON.stringify(entry.data)}` : "";

	return `${prefix} ${time} [${entry.component}] ${entry.message}${dataStr}`;
}

/**
 * Output log entry to console
 */
function output(entry: LogEntry): void {
	if (globalConfig.handler) {
		globalConfig.handler(entry);
		return;
	}

	const line = formatLogLine(entry);
	const isBrowser = typeof window !== "undefined";

	if (isBrowser) {
		const color = LEVEL_COLOR[entry.level];
		const style = `color: ${color}; font-weight: ${entry.level === "error" ? "bold" : "normal"}`;

		switch (entry.level) {
			case "error":
				console.error(`%c${line}`, style);
				break;
			case "warn":
				console.warn(`%c${line}`, style);
				break;
			default:
				console.log(`%c${line}`, style);
		}
	} else {
		// Node.js - plain output
		switch (entry.level) {
			case "error":
				console.error(line);
				break;
			case "warn":
				console.warn(line);
				break;
			default:
				console.log(line);
		}
	}
}

/**
 * Create a component-scoped logger
 *
 * @example
 * ```ts
 * const log = createLogger('RoomManager');
 * log.debug('Joining room', { roomId: 'abc' });
 * log.info('Connected');
 * log.warn('Reconnecting', { attempt: 2 });
 * log.error('Failed to connect', { code: 500 });
 * ```
 */
export function createLogger(component: string) {
	const shouldLog = (level: LogLevel): boolean => {
		if (!globalConfig.enabled) return false;
		const minLevel = globalConfig.level ?? "debug";
		return LEVEL_PRIORITY[level] >= LEVEL_PRIORITY[minLevel];
	};

	const log = (level: LogLevel, message: string, data?: unknown): void => {
		if (!shouldLog(level)) return;

		const entry: LogEntry = {
			timestamp: Date.now(),
			level,
			component,
			message,
			data: formatData(data),
		};

		output(entry);
	};

	return {
		/** Debug level - verbose internal state */
		debug: (msg: string, data?: unknown) => log("debug", msg, data),

		/** Info level - key lifecycle events */
		info: (msg: string, data?: unknown) => log("info", msg, data),

		/** Warn level - recoverable issues */
		warn: (msg: string, data?: unknown) => log("warn", msg, data),

		/** Error level - failures */
		error: (msg: string, data?: unknown) => log("error", msg, data),

		/** Log event with action name */
		event: (action: string, data?: unknown) =>
			log("debug", `event:${action}`, data),

		/** Log state change */
		state: (field: string, value: unknown) =>
			log("debug", `state:${field}`, { value }),

		/** Check if debug logging is active */
		get enabled(): boolean {
			return globalConfig.enabled;
		},
	};
}

/** Logger instance type */
export type Logger = ReturnType<typeof createLogger>;

/**
 * Initialize logging from SDK config
 * Call this when SDK is initialized with debug: true
 */
export function initLogging(debug: boolean): void {
	configureLogger({ enabled: debug });

	if (debug) {
		const log = createLogger("Chalk");
		log.info("Debug logging enabled");
	}
}
