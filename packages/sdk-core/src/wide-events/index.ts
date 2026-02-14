/**
 * Wide Events - Canonical log lines for Chalk SDK
 *
 * @packageDocumentation
 * @module @q9labs/chalk-core/wide-events
 */

export { WideEventContext } from "./context";
export { WideEventCollector, wideEventsCollector } from "./collector";
export { getSdkEnvironment, detectPlatform } from "./environment";
export type {
	WideEvent,
	WideEventConfig,
	WideEventOutcome,
	WideEventPlatform,
	WideEventSdk,
	WideEventError,
	WideEventType,
} from "./types";

export {
	createAxiomWideEventsHandler,
	type AxiomWideEventsConfig,
	type AxiomWideEventsHandler,
} from "./axiom";

import { wideEventsCollector } from "./collector";
import type { WideEventConfig } from "./types";
import { WideEventContext } from "./context";

/**
 * Wide Events API - main interface for instrumentation
 *
 * @example
 * ```ts
 * // Configure on client init
 * wideEvents.configure({ enabled: true });
 *
 * // Instrument an operation
 * const ctx = wideEvents.start("room.join");
 * ctx.set("roomId", roomId);
 * ctx.markPhase("api");
 * const result = await api.join(roomId);
 * ctx.markPhase("rtk");
 * await rtk.join();
 * ctx.complete("success", { participantCount: 5 });
 * ```
 */
export const wideEvents = {
	/**
	 * Configure wide events
	 */
	configure(config: WideEventConfig): void {
		wideEventsCollector.configure(config);
	},

	/**
	 * Start a new event context
	 */
	start(eventType: string): WideEventContext {
		return wideEventsCollector.start(eventType);
	},

	/**
	 * Set the current room ID (for event context)
	 */
	setRoomId(roomId: string | null): void {
		wideEventsCollector.setRoomId(roomId);
	},

	/**
	 * Set the current participant ID (for event context)
	 */
	setParticipantId(participantId: string | null): void {
		wideEventsCollector.setParticipantId(participantId);
	},

	/**
	 * Get current session ID
	 */
	get sessionId(): string {
		return wideEventsCollector.sessionId;
	},

	/**
	 * Check if wide events are enabled
	 */
	get isEnabled(): boolean {
		return wideEventsCollector.isEnabled;
	},

	/**
	 * Enrich the active context with additional data
	 */
	enrichActiveContext(key: string, value: unknown): void {
		wideEventsCollector.enrichActiveContext(key, value);
	},

	/**
	 * Reset collector state
	 */
	reset(): void {
		wideEventsCollector.reset();
	},

	/**
	 * Access the underlying collector (for advanced use)
	 */
	get collector(): typeof wideEventsCollector {
		return wideEventsCollector;
	},
};

/**
 * Configure wide events
 * @deprecated Use wideEvents.configure() instead
 */
export function configureWideEvents(config: WideEventConfig): void {
	wideEvents.configure(config);
}
