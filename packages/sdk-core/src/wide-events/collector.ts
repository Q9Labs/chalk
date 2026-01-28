/**
 * Wide Event Collector - global singleton for event management
 *
 * @packageDocumentation
 * @module @q9labs/chalk-core/wide-events
 */

import { WideEventContext } from "./context";
import { createEmitter } from "./emitter";
import { generateSessionId } from "./environment";
import type { WideEvent, WideEventConfig } from "./types";

/**
 * WideEventCollector - singleton that manages event contexts and emission
 *
 * Usage:
 * ```ts
 * // Initialize once when SDK starts
 * wideEvents.configure({ enabled: true });
 *
 * // Start an event context
 * const ctx = wideEvents.start("room.join");
 * ctx.set("roomId", roomId);
 * ctx.markPhase("api");
 * // ... work ...
 * ctx.complete("success");
 *
 * // Set global context (roomId, participantId)
 * wideEvents.setRoomId("room_123");
 * wideEvents.setParticipantId("part_456");
 * ```
 */
export class WideEventCollector {
	private _config: WideEventConfig = {
		enabled: false,
		includeDebugInfo: false,
	};
	private _sessionId: string;
	private _roomId: string | null = null;
	private _participantId: string | null = null;
	private _activeContext: WideEventContext | null = null;
	private _emitter: ((event: WideEvent) => void) | null = null;

	constructor() {
		this._sessionId = generateSessionId();
	}

	/**
	 * Configure the collector
	 */
	configure(config: WideEventConfig): void {
		this._config = { ...this._config, ...config };

		if (config.sessionId) {
			this._sessionId = config.sessionId;
		}

		this._emitter = createEmitter(this._config);
	}

	/**
	 * Get current configuration
	 */
	get config(): WideEventConfig {
		return this._config;
	}

	/**
	 * Get current session ID
	 */
	get sessionId(): string {
		return this._sessionId;
	}

	/**
	 * Get current room ID
	 */
	get roomId(): string | null {
		return this._roomId;
	}

	/**
	 * Set current room ID (for event context)
	 */
	setRoomId(roomId: string | null): void {
		this._roomId = roomId;
	}

	/**
	 * Get current participant ID
	 */
	get participantId(): string | null {
		return this._participantId;
	}

	/**
	 * Set current participant ID (for event context)
	 */
	setParticipantId(participantId: string | null): void {
		this._participantId = participantId;
	}

	/**
	 * Check if wide events are enabled
	 */
	get isEnabled(): boolean {
		return this._config.enabled ?? false;
	}

	/**
	 * Start a new event context
	 */
	start(eventType: string): WideEventContext {
		const ctx = new WideEventContext(eventType, this);
		this._activeContext = ctx;
		return ctx;
	}

	/**
	 * Get the currently active context (if any)
	 */
	get activeContext(): WideEventContext | null {
		return this._activeContext;
	}

	/**
	 * Enrich the active context with additional data
	 * Useful for Effect-based code that can't easily pass context
	 */
	enrichActiveContext(key: string, value: unknown): void {
		if (this._activeContext && !this._activeContext.isCompleted) {
			this._activeContext.set(key, value);
		}
	}

	/**
	 * Emit a completed event
	 */
	emit(event: WideEvent): void {
		if (!this._config.enabled && !this._config.handler) return;

		if (this._emitter) {
			this._emitter(event);
		}

		// Clear active context if it matches
		if (
			this._activeContext &&
			this._activeContext.isCompleted &&
			event.eventId === (this._activeContext as unknown as { eventId: string }).eventId
		) {
			this._activeContext = null;
		}
	}

	/**
	 * Reset collector state (for testing or reconnection)
	 */
	reset(): void {
		this._roomId = null;
		this._participantId = null;
		this._activeContext = null;
		this._sessionId = generateSessionId();
	}
}

/**
 * Global wide events collector instance
 */
export const wideEventsCollector = new WideEventCollector();
