import type { SyncClock } from "./types";

/** One pending timer per ID. A timer forgets itself when it fires. */
export class V1TimerMap {
  readonly #clock: () => SyncClock;
  readonly #timers = new Map<string, unknown>();

  constructor(clock: () => SyncClock) {
    this.#clock = clock;
  }

  has(id: string): boolean {
    return this.#timers.has(id);
  }

  schedule(id: string, callback: () => void, delayMs: number): void {
    this.#timers.set(
      id,
      this.#clock().setTimeout(() => {
        this.#timers.delete(id);
        callback();
      }, delayMs),
    );
  }

  cancel(id: string): void {
    const timer = this.#timers.get(id);
    if (timer === undefined) return;
    this.#clock().clearTimeout(timer);
    this.#timers.delete(id);
  }

  cancelAll(): void {
    for (const timer of this.#timers.values()) this.#clock().clearTimeout(timer);
    this.#timers.clear();
  }
}
