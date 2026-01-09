/**
 * Event emitter for Chalk SDK
 */

import { createLogger } from "./utils/logger.ts";

type EventHandler<T = unknown> = (data: T) => void;

const log = createLogger("Events");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export class EventEmitter<Events extends Record<string, any>> {
	private handlers: Map<keyof Events, Set<EventHandler>> = new Map();

	on<K extends keyof Events>(
		event: K,
		handler: EventHandler<Events[K]>,
	): () => void {
		if (!this.handlers.has(event)) {
			this.handlers.set(event, new Set());
		}
		this.handlers.get(event)!.add(handler as EventHandler);

		// Return unsubscribe function
		return () => this.off(event, handler);
	}

	off<K extends keyof Events>(
		event: K,
		handler: EventHandler<Events[K]>,
	): void {
		this.handlers.get(event)?.delete(handler as EventHandler);
	}

	protected emit<K extends keyof Events>(event: K, data: Events[K]): void {
		this.handlers.get(event)?.forEach((handler) => {
			try {
				handler(data);
			} catch (error) {
				log.error(`Error in event handler for ${String(event)}:`, error);
			}
		});
	}

	removeAllListeners(event?: keyof Events): void {
		if (event) {
			this.handlers.delete(event);
		} else {
			this.handlers.clear();
		}
	}
}
