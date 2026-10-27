import type { ConnectionErrorCode, ConnectionState } from "./types";

export type ConnectionDiagnosticEventName =
  | "sync_dial_timeout"
  | "sync_connect_failed"
  | "connection_failed"
  | "state_changed"
  | "access_refreshed"
  | "access_refresh_failed"
  | "recovery_attempt"
  | "recovery_succeeded"
  | "recovery_exhausted"
  | "cleanup_completed"
  | "cleanup_unconfirmed"
  | "space_join_span";

export type ConnectionJoinTraceStep = "join" | "acquire_initial_media" | "access_initialize" | "create_media_client" | "create_sync_client" | "start_media" | "start_sync" | "wait_for_sync_live" | "confirm_entered";

export type ConnectionJoinTraceOutcome = "started" | "succeeded" | "failed" | "cancelled";

export type ConnectionJoinTraceEvent = ConnectionDiagnostic & {
  readonly event: "space_join_span";
  readonly step: ConnectionJoinTraceStep;
  readonly spanId: string;
  readonly parentSpanId?: string;
  readonly outcome: ConnectionJoinTraceOutcome;
};

export type ConnectionJoinTraceSpan = {
  readonly spanId: string;
  readonly end: (input: ConnectionJoinTraceEnd) => void;
};

export type ConnectionJoinTraceEnd = {
  readonly state: ConnectionState;
  readonly epoch: number;
  readonly outcome: Exclude<ConnectionJoinTraceOutcome, "started">;
  readonly code?: ConnectionErrorCode;
};

export type ConnectionDiagnostic = {
  readonly timestamp: number;
  readonly event: ConnectionDiagnosticEventName;
  readonly state: ConnectionState;
  readonly epoch: number;
  readonly attempt?: number;
  readonly code?: ConnectionErrorCode;
  readonly step?: ConnectionJoinTraceStep;
  readonly spanId?: string;
  readonly parentSpanId?: string;
  readonly outcome?: ConnectionJoinTraceOutcome;
  readonly durationMs?: number;
  readonly sync?: import("../sync/connect-diagnostics").SyncConnectDiagnostic;
  readonly recovery?: {
    readonly reference: "connection.sync_recovery_exhausted" | "connection.media_recovery_exhausted";
    readonly attempts: number;
    readonly transport: import("../sync/connect-diagnostics").SyncRecoveryDiagnostic | null;
    readonly lastHeartbeatReplyAgoMs: number | null;
    readonly visibilityState: DocumentVisibilityState | null;
  };
};

export class ConnectionDiagnostics {
  readonly #limit: number;
  readonly #now: () => number;
  readonly #onEvent: ((event: ConnectionDiagnostic) => void) | undefined;
  readonly #events: ConnectionDiagnostic[] = [];
  #spanSequence = 0;

  constructor(options: { readonly now: () => number; readonly limit?: number; readonly onEvent?: (event: ConnectionDiagnostic) => void }) {
    this.#now = options.now;
    this.#limit = Math.max(1, Math.min(200, options.limit ?? 50));
    this.#onEvent = options.onEvent;
  }

  record(input: Omit<ConnectionDiagnostic, "timestamp">): void {
    const event = Object.freeze({ timestamp: this.#now(), ...input, ...(input.sync ? { sync: Object.freeze({ ...input.sync }) } : {}) });
    this.#events.push(event);
    if (this.#events.length > this.#limit) this.#events.splice(0, this.#events.length - this.#limit);
    try {
      this.#onEvent?.(event);
    } catch {
      // Diagnostics callbacks cannot affect Connection state or cleanup.
    }
  }

  recordRecoveryExhausted(input: { readonly state: ConnectionState; readonly epoch: number; readonly code: "sync_recovery_exhausted" | "media_recovery_exhausted"; readonly attempts: number; readonly transport: import("../sync/connect-diagnostics").SyncRecoveryDiagnostic | null }): void {
    const { state, epoch, code, attempts, transport } = input;
    this.record({
      event: "recovery_exhausted",
      state,
      epoch,
      code,
      recovery: {
        reference: `connection.${code}`,
        attempts,
        transport,
        lastHeartbeatReplyAgoMs: transport?.lastHeartbeatReplyAt == null ? null : Math.max(0, this.#now() - transport.lastHeartbeatReplyAt),
        visibilityState: typeof document === "undefined" ? null : document.visibilityState,
      },
    });
  }

  snapshot(): readonly ConnectionDiagnostic[] {
    return Object.freeze([...this.#events]);
  }

  startSpan(input: { readonly step: ConnectionJoinTraceStep; readonly state: ConnectionState; readonly epoch: number; readonly parentSpanId?: string }): ConnectionJoinTraceSpan {
    const spanId = `space-join-span-${++this.#spanSequence}`;
    const startedAt = this.#now();
    let ended = false;
    this.record({ event: "space_join_span", state: input.state, epoch: input.epoch, step: input.step, spanId, ...(input.parentSpanId ? { parentSpanId: input.parentSpanId } : {}), outcome: "started" });

    return {
      spanId,
      end: (end) => {
        if (ended) return;
        ended = true;
        this.record({
          event: "space_join_span",
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

  joinTrace(): readonly ConnectionJoinTraceEvent[] {
    return Object.freeze(this.#events.filter((event): event is ConnectionJoinTraceEvent => event.event === "space_join_span"));
  }
}
