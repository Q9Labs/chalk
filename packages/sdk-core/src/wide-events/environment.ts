/**
 * Environment detection for wide events
 *
 * @packageDocumentation
 * @module @q9labs/chalk-core/wide-events
 */

import type { WideEventPlatform, WideEventSdk } from "./types";

/** SDK version - read from package.json at build time */
const SDK_VERSION = "0.0.49";

/**
 * Detect the current platform
 */
export function detectPlatform(): WideEventPlatform {
	// React Native detection
	if (
		typeof navigator !== "undefined" &&
		navigator.product === "ReactNative"
	) {
		return "react-native";
	}

	// Browser detection
	if (typeof window !== "undefined" && typeof document !== "undefined") {
		return "browser";
	}

	// Node.js / SSR
	return "node";
}

/**
 * Get user agent string (browser only)
 */
export function getUserAgent(): string | undefined {
	if (typeof navigator !== "undefined" && navigator.userAgent) {
		return navigator.userAgent;
	}
	return undefined;
}

/**
 * Get SDK environment information
 */
export function getSdkEnvironment(): WideEventSdk {
	return {
		version: SDK_VERSION,
		platform: detectPlatform(),
		userAgent: getUserAgent(),
	};
}

/**
 * Generate a unique session ID
 */
export function generateSessionId(): string {
	// Use crypto.randomUUID if available (browser/node 19+)
	if (typeof crypto !== "undefined" && crypto.randomUUID) {
		return crypto.randomUUID();
	}

	// Fallback for older environments
	return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
		const r = (Math.random() * 16) | 0;
		const v = c === "x" ? r : (r & 0x3) | 0x8;
		return v.toString(16);
	});
}

/**
 * Generate a unique event ID
 */
export function generateEventId(): string {
	return generateSessionId();
}
