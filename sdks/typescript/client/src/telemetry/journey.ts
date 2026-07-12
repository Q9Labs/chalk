import { rtcSummaryAttributes, type RtcConnectionStateSnapshot, type RtcStatsLike } from "./rtc";
import { journeyHeaders } from "./trace";
import type { JourneyPhase, JourneyState, JourneyTelemetryContext, TelemetryAttributes, TelemetryEvent, TelemetryEventDraft } from "./types";

export type StartJourneyOptions = {
  readonly attributes?: TelemetryAttributes;
  readonly journeyId?: string;
  readonly kind: string;
  readonly parent?: TelemetryJourney;
  readonly traceparent?: string;
  readonly tracestate?: string;
};

export type HttpRequestObservation = {
  readonly durationMs?: number;
  readonly method: string;
  readonly route: string;
  readonly statusCode?: number;
  readonly state?: Extract<JourneyState, "failed" | "observed" | "succeeded">;
};

export type SyncFrameObservation = {
  readonly direction: "client_to_server" | "server_to_client";
  readonly frameType: string;
  readonly state?: Extract<JourneyState, "failed" | "observed" | "succeeded">;
};

export type DiagnosticObservation = {
  readonly category: "device" | "network" | "permission" | "recovery" | "session";
  readonly code: string;
  readonly phase?: JourneyPhase;
  readonly state?: Extract<JourneyState, "failed" | "observed" | "succeeded">;
};

export type JourneyTelemetryHost = {
  emit(context: JourneyTelemetryContext, sequence: number, draft: TelemetryEventDraft): TelemetryEvent;
  startJourney(options: StartJourneyOptions): TelemetryJourney;
};

export class TelemetryJourney {
  readonly context: JourneyTelemetryContext;
  readonly #telemetry: JourneyTelemetryHost;
  #lastEventId: string | undefined;
  #sequence = 0;
  #terminalEvent: TelemetryEvent | undefined;

  constructor(telemetry: JourneyTelemetryHost, context: JourneyTelemetryContext) {
    this.#telemetry = telemetry;
    this.context = context;
  }

  get headers(): Record<string, string> {
    return journeyHeaders(this.context);
  }

  phase(phase: Exclude<JourneyPhase, "root" | "terminal">, attributes?: TelemetryAttributes): TelemetryEvent | undefined {
    if (this.#terminalEvent) return undefined;
    return this.record({ name: "journey.phase", phase, state: "in_progress", origin_kind: "client", attributes });
  }

  terminal(state: Extract<JourneyState, "cancelled" | "failed" | "succeeded">, attributes?: TelemetryAttributes): TelemetryEvent {
    if (this.#terminalEvent) return this.#terminalEvent;
    this.#terminalEvent = this.record({ name: "journey.terminal", phase: "terminal", state, origin_kind: "client", attributes });
    return this.#terminalEvent;
  }

  recordHttpRequest(observation: HttpRequestObservation): TelemetryEvent | undefined {
    if (this.#terminalEvent) return undefined;
    return this.record({
      name: "http.request",
      phase: "signaling",
      state: observation.state || "observed",
      origin_kind: "http",
      attributes: httpObservationAttributes(observation),
    });
  }

  recordSyncFrame(observation: SyncFrameObservation): TelemetryEvent | undefined {
    if (this.#terminalEvent) return undefined;
    return this.record({
      name: "sync.frame",
      phase: "signaling",
      state: observation.state ?? "observed",
      origin_kind: "sync",
      upstream_visibility: "propagated",
      attributes: { direction: observation.direction, frame_type: observation.frameType },
    });
  }

  recordRtcSummary(connection: RtcConnectionStateSnapshot, stats: Iterable<RtcStatsLike>, state: Extract<JourneyState, "failed" | "observed" | "succeeded"> = "observed"): TelemetryEvent | undefined {
    if (this.#terminalEvent) return undefined;
    return this.record({ name: "rtc.summary", phase: "media", state, origin_kind: "rtc", attributes: rtcSummaryAttributes(connection, stats) });
  }

  recordDiagnostic(observation: DiagnosticObservation): TelemetryEvent | undefined {
    if (this.#terminalEvent) return undefined;
    return this.record({
      name: "diagnostic.timeline",
      phase: observation.phase ?? "recovery",
      state: observation.state ?? "observed",
      origin_kind: "diagnostic",
      attributes: { category: observation.category, code: observation.code },
    });
  }

  startChild(options: Omit<StartJourneyOptions, "parent">): TelemetryJourney {
    return this.#telemetry.startJourney({ ...options, parent: this });
  }

  record(draft: TelemetryEventDraft): TelemetryEvent {
    const event = this.#telemetry.emit(this.context, ++this.#sequence, {
      ...draft,
      ...(draft.parent_event_id || !this.#lastEventId ? {} : { parent_event_id: this.#lastEventId }),
    });
    this.#lastEventId = event.event_id;
    return event;
  }

  linkChild(child: JourneyTelemetryContext): string {
    return this.record({
      name: "journey.linked",
      phase: "root",
      state: "observed",
      origin_kind: "client",
      parent_event_id: this.#lastEventId!,
      attributes: { child_journey_id: child.journeyId, relationship: "fanout" },
    }).event_id;
  }

  start(kind: string, attributes: TelemetryAttributes | undefined, parentEventId: string | undefined): void {
    const event = this.#telemetry.emit(this.context, ++this.#sequence, {
      name: "journey.started",
      phase: "root",
      state: "started",
      origin_kind: "client",
      ...(parentEventId ? { parent_event_id: parentEventId } : {}),
      attributes: { ...attributes, journey_kind: kind },
    });
    this.#lastEventId = event.event_id;
  }
}

function httpObservationAttributes(observation: HttpRequestObservation): TelemetryAttributes {
  return {
    method: observation.method.toUpperCase(),
    route: observation.route,
    ...(observation.durationMs !== undefined ? { duration_ms: Math.round(observation.durationMs) } : {}),
    ...(observation.statusCode !== undefined ? { status_code: observation.statusCode } : {}),
  };
}
