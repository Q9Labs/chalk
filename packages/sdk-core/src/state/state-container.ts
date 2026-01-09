/**
 * Observable state container for Chalk SDK managers
 *
 * @packageDocumentation
 * @module @q9labs/chalk-core/state
 */

import { createLogger } from "../utils/logger.ts";

type StateListener<T> = (state: T, prevState: T) => void;

const log = createLogger("StateContainer");

/**
 * Base class for observable state management in SDK managers.
 *
 * Provides a simple pub/sub pattern for state changes that React hooks
 * can subscribe to for re-rendering.
 *
 * @typeParam TState - State object shape
 *
 * @example
 * ```ts
 * interface MediaState {
 *   isVideoEnabled: boolean;
 *   isAudioEnabled: boolean;
 * }
 *
 * class MediaManager extends StateContainer<MediaState> {
 *   constructor() {
 *     super({ isVideoEnabled: false, isAudioEnabled: false });
 *   }
 *
 *   toggleVideo(): void {
 *     this.setState(prev => ({ isVideoEnabled: !prev.isVideoEnabled }));
 *   }
 * }
 * ```
 */
export abstract class StateContainer<TState extends object> {
  private state: TState;
  private listeners = new Set<StateListener<TState>>();

  constructor(initialState: TState) {
    this.state = initialState;
  }

  /**
   * Get current state (readonly to prevent mutation)
   */
  getState(): Readonly<TState> {
    return this.state;
  }

  /**
   * Subscribe to state changes
   * @returns Unsubscribe function
   */
  subscribe(listener: StateListener<TState>): () => void {
    this.listeners.add(listener);
    return (): void => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Update state and notify listeners.
   * Accepts partial state or updater function.
   */
  protected setState(
    updater: Partial<TState> | ((prev: TState) => Partial<TState>)
  ): void {
    const prevState = this.state;
    const updates = typeof updater === 'function' ? updater(prevState) : updater;
    this.state = { ...prevState, ...updates };
    this.listeners.forEach((listener) => {
      try {
        listener(this.state, prevState);
      } catch (error) {
        log.error('[StateContainer] Error in listener:', error);
      }
    });
  }

  /**
   * Number of active listeners
   */
  get listenerCount(): number {
    return this.listeners.size;
  }
}
