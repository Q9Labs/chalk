import type { ChalkSessionErrorCode, ChalkSessionState } from "./types";

export type ChalkSessionDiagnosticEventName = "state_changed" | "access_refreshed" | "access_refresh_failed" | "recovery_attempt" | "recovery_succeeded" | "recovery_exhausted" | "cleanup_completed" | "cleanup_unconfirmed" | "join_span";

export type ChalkSessionJoinTraceStep = "join" | "acquire_initial_media" | "access_initialize" | "create_media_client" | "create_sync_client" | "start_media" | "start_sync" | "wait_for_sync_live";

export type ChalkSessionJoinTraceOutcome = "started" | "succeeded" | "failed" | "cancelled";

export type ChalkSessionJoinTraceEvent = ChalkSessionDiagnostic & {
  readonly event: "join_span";
  readonly step: ChalkSessionJoinTraceStep;
  readonly spanId: string;
  readonly parentSpanId?: string;
  readonly outcome: ChalkSessionJoinTraceOutcome;
};

export type ChalkSessionJoinTraceSpan = {
  readonly spanId: string;
  readonly end: (input: ChalkSessionJoinTraceEnd) => void;
};

export type ChalkSessionJoinTraceEnd = {
  readonly state: ChalkSessionState;
  readonly epoch: number;
  readonly outcome: Exclude<ChalkSessionJoinTraceOutcome, "started">;
  readonly code?: ChalkSessionErrorCode;
};

export type ChalkSessionDiagnostic = {
  readonly timestamp: number;
  readonly event: ChalkSessionDiagnosticEventName;
  readonly state: ChalkSessionState;
  readonly epoch: number;
  readonly attempt?: number;
  readonly code?: ChalkSessionErrorCode;
  readonly step?: ChalkSessionJoinTraceStep;
  readonly spanId?: string;
  readonly parentSpanId?: string;
  readonly outcome?: ChalkSessionJoinTraceOutcome;
  readonly durationMs?: number;
};

export class ChalkSessionDiagnostics {
  readonly #limit: number;
  readonly #now: () => number;
  readonly #onEvent: ((event: ChalkSessionDiagnostic) => void) | undefined;
  readonly #events: ChalkSessionDiagnostic[] = [];
  #spanSequence = 0;

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

  startSpan(input: { readonly step: ChalkSessionJoinTraceStep; readonly state: ChalkSessionState; readonly epoch: number; readonly parentSpanId?: string }): ChalkSessionJoinTraceSpan {
    const spanId = `join-span-${++this.#spanSequence}`;
    const startedAt = this.#now();
    let ended = false;
    this.record({ event: "join_span", state: input.state, epoch: input.epoch, step: input.step, spanId, ...(input.parentSpanId ? { parentSpanId: input.parentSpanId } : {}), outcome: "started" });

    return {
      spanId,
      end: (end) => {
        if (ended) return;
        ended = true;
        this.record({
          event: "join_span",
          state: end.state,
          epoch: end.epoch,
          step: input.step,
          spanId,
          ...(input.parentSpanId ? { parentSpanId: input.parentSpanId } : {}),
          outcome: end.outcome,
          durationMs: Math.max(0, this.#now() - startedAt),
          ...(end.code ? { code: end.code } : {}),
        });
      },
    };
  }

  joinTrace(): readonly ChalkSessionJoinTraceEvent[] {
    return Object.freeze(this.#events.filter((event): event is ChalkSessionJoinTraceEvent => event.event === "join_span"));
  }
}
