/**
 * Wide Event Emitter - output handling
 *
 * @packageDocumentation
 * @module @q9labs/chalk-core/wide-events
 */

import type { WideEvent, WideEventConfig } from "./types";

/**
 * Emit a wide event to console (JSON format)
 */
export function emitToConsole(event: WideEvent): void {
	const isBrowser = typeof window !== "undefined";

	// Format for readability in dev tools
	const logLine = JSON.stringify(event, null, isBrowser ? 2 : 0);

	if (event.outcome === "error") {
		console.error(`[Chalk] ${event.eventType}`, logLine);
	} else {
		console.log(`[Chalk] ${event.eventType}`, logLine);
	}
}

/**
 * Create an emitter function based on config
 */
export function createEmitter(
	config: WideEventConfig
): (event: WideEvent) => void {
	return (event: WideEvent) => {
		// Always call custom handler if provided
		if (config.handler) {
			try {
				config.handler(event);
			} catch {
				// Silently ignore handler errors to not break SDK
			}
		}

		// Log to console in debug mode (when enabled and no custom handler)
		if (config.enabled && !config.handler) {
			emitToConsole(event);
		}
	};
}
