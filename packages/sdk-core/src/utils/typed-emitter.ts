/**
 * Type-safe event emitter for Chalk SDK
 *
 * Provides compile-time validation of event names and payload types.
 *
 * @packageDocumentation
 * @module @q9labs/chalk-core/utils
 */

type EventHandler<T> = (data: T) => void;

/**
 * A type-safe event emitter that validates event names and payloads at compile time.
 *
 * @typeParam TEventMap - Record mapping event names to their payload types
 *
 * @example
 * ```ts
 * interface MyEvents {
 *   'user:joined': { userId: string; name: string };
 *   'user:left': { userId: string };
 * }
 *
 * class MyEmitter extends TypedEventEmitter<MyEvents> {
 *   notifyJoin(userId: string, name: string): void {
 *     this.emit('user:joined', { userId, name }); // Type-checked!
 *   }
 * }
 *
 * const emitter = new MyEmitter();
 * emitter.on('user:joined', ({ userId, name }) => {
 *   // userId and name are correctly typed as string
 * });
 * ```
 */
export class TypedEventEmitter<TEventMap extends object> {
	private listeners = new Map<keyof TEventMap, Set<EventHandler<unknown>>>();

	/**
	 * Subscribe to an event.
	 *
	 * @param event - Event name to listen for
	 * @param handler - Handler function called when event is emitted
	 * @returns Unsubscribe function - call to remove the listener
	 *
	 * @example
	 * ```ts
	 * const unsubscribe = emitter.on('user:joined', (data) => {
	 *   console.log(data.userId);
	 * });
	 *
	 * // Later, to stop listening:
	 * unsubscribe();
	 * ```
	 */
	on<K extends keyof TEventMap>(
		event: K,
		handler: EventHandler<TEventMap[K]>,
	): () => void {
		if (!this.listeners.has(event)) {
			this.listeners.set(event, new Set());
		}
		this.listeners.get(event)!.add(handler as EventHandler<unknown>);

		// Return unsubscribe function
		return (): void => {
			this.listeners.get(event)?.delete(handler as EventHandler<unknown>);
		};
	}

	/**
	 * Emit an event to all registered listeners.
	 *
	 * @param event - Event name to emit
	 * @param data - Payload data (must match TEventMap[event] type)
	 */
	emit<K extends keyof TEventMap>(event: K, data: TEventMap[K]): void {
		this.listeners.get(event)?.forEach((handler) => {
			try {
				handler(data);
			} catch (error) {
				console.error(`Error in event handler for ${String(event)}:`, error);
			}
		});
	}

	/**
	 * Remove a specific event listener.
	 *
	 * @param event - Event name
	 * @param handler - The exact handler function to remove
	 */
	off<K extends keyof TEventMap>(
		event: K,
		handler: EventHandler<TEventMap[K]>,
	): void {
		this.listeners.get(event)?.delete(handler as EventHandler<unknown>);
	}

	/**
	 * Subscribe to an event for a single emission only.
	 * The listener is automatically removed after the first event.
	 *
	 * @param event - Event name to listen for
	 * @param handler - Handler function called once when event is emitted
	 * @returns Unsubscribe function - call to cancel before event fires
	 */
	once<K extends keyof TEventMap>(
		event: K,
		handler: EventHandler<TEventMap[K]>,
	): () => void {
		const wrappedHandler = (data: TEventMap[K]): void => {
			this.off(event, wrappedHandler);
			handler(data);
		};
		return this.on(event, wrappedHandler);
	}

	/**
	 * Remove all listeners for a specific event, or all events if no event specified.
	 *
	 * @param event - Optional event name. If omitted, removes all listeners.
	 */
	removeAllListeners(event?: keyof TEventMap): void {
		if (event) {
			this.listeners.delete(event);
		} else {
			this.listeners.clear();
		}
	}

	/**
	 * Get the number of listeners for a specific event.
	 *
	 * @param event - Event name
	 * @returns Number of registered listeners
	 */
	listenerCount(event: keyof TEventMap): number {
		return this.listeners.get(event)?.size ?? 0;
	}
}
