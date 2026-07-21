import type { ChalkSessionErrorCode, ChalkSessionState } from "./types";

export type ChalkSessionDiagnosticEventName = "state_changed" | "access_refreshed" | "access_refresh_failed" | "recovery_attempt" | "recovery_succeeded" | "recovery_exhausted" | "cleanup_completed";

export type ChalkSessionDiagnostic = {
  readonly timestamp: number;
  readonly event: ChalkSessionDiagnosticEventName;
  readonly state: ChalkSessionState;
  readonly epoch: number;
  readonly attempt?: number;
  readonly code?: ChalkSessionErrorCode;
};

export class ChalkSessionDiagnostics {
  readonly #limit: number;
  readonly #now: () => number;
  readonly #onEvent: ((event: ChalkSessionDiagnostic) => void) | undefined;
  readonly #events: ChalkSessionDiagnostic[] = [];

  constructor(options: { readonly now: () => number; readonly limit?: number; readonly onEvent?: (event: ChalkSessionDiagnostic) => void }) {
    this.#now = options.now;
    this.#limit = Math.max(1, Math.min(200, options.limit ?? 50));
    this.#onEvent = options.onEvent;
  }

  record(input: Omit<ChalkSessionDiagnostic, "timestamp">): void {
    const event = Object.freeze({ timestamp: this.#now(), ...input });
    this.#events.push(event);
    if (this.#events.length > this.#limit) this.#events.splice(0, this.#events.length - this.#limit);
    try {
      this.#onEvent?.(event);
    } catch {
      // Diagnostics callbacks cannot affect session state or cleanup.
    }
  }

  snapshot(): readonly ChalkSessionDiagnostic[] {
    return Object.freeze([...this.#events]);
  }
}
