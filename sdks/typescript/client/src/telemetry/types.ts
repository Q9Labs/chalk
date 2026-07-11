export const TELEMETRY_EVENT_VERSION = 1 as const;

export type TelemetryAttributeValue = boolean | number | string;
export type TelemetryAttributes = Readonly<Record<string, TelemetryAttributeValue>>;

export type JourneyPhase = "root" | "authentication" | "signaling" | "media" | "recovery" | "terminal";
export type JourneyState = "started" | "in_progress" | "succeeded" | "failed" | "cancelled" | "observed";
export type TelemetryOriginKind = "client" | "diagnostic" | "http" | "rtc" | "sync";
export type TelemetryUpstreamVisibility = "local" | "propagated";

export interface TelemetryEventBase {
  readonly version: typeof TELEMETRY_EVENT_VERSION;
  readonly event_id: string;
  readonly journey_id: string;
  readonly sequence: number;
  readonly occurred_at: string;
  readonly phase: JourneyPhase;
  readonly state: JourneyState;
  readonly origin_kind: TelemetryOriginKind;
  readonly first_observed_layer: TelemetryOriginKind;
  readonly upstream_visibility: TelemetryUpstreamVisibility;
  readonly parent_event_id?: string;
  readonly trace_id?: string;
  readonly span_id?: string;
  readonly traceparent?: string;
  readonly tracestate?: string;
  readonly attributes?: TelemetryAttributes;
}

export type JourneyStartedEvent = TelemetryEventBase & {
  readonly name: "journey.started";
  readonly phase: "root";
  readonly state: "started";
  readonly origin_kind: "client";
};

export type JourneyPhaseEvent = TelemetryEventBase & {
  readonly name: "journey.phase";
  readonly phase: Exclude<JourneyPhase, "root" | "terminal">;
  readonly state: "in_progress" | "observed";
  readonly origin_kind: "client";
};

export type JourneyTerminalEvent = TelemetryEventBase & {
  readonly name: "journey.terminal";
  readonly phase: "terminal";
  readonly state: "succeeded" | "failed" | "cancelled";
  readonly origin_kind: "client";
};

export type JourneyLinkedEvent = TelemetryEventBase & {
  readonly name: "journey.linked";
  readonly phase: "root";
  readonly state: "observed";
  readonly origin_kind: "client";
  readonly parent_event_id: string;
};

export type HttpRequestTelemetryEvent = TelemetryEventBase & {
  readonly name: "http.request";
  readonly origin_kind: "http";
};

export type SyncFrameTelemetryEvent = TelemetryEventBase & {
  readonly name: "sync.frame";
  readonly origin_kind: "sync";
};

export type RtcSummaryTelemetryEvent = TelemetryEventBase & {
  readonly name: "rtc.summary";
  readonly origin_kind: "rtc";
};

export type DiagnosticTimelineTelemetryEvent = TelemetryEventBase & {
  readonly name: "diagnostic.timeline";
  readonly origin_kind: "diagnostic";
};

/** A stable, versioned client event union. Exporters remove only `version`, because the v1 intake path carries the API version. */
export type TelemetryEvent = DiagnosticTimelineTelemetryEvent | HttpRequestTelemetryEvent | JourneyLinkedEvent | JourneyPhaseEvent | JourneyStartedEvent | JourneyTerminalEvent | RtcSummaryTelemetryEvent | SyncFrameTelemetryEvent;

export type TelemetryEventName = TelemetryEvent["name"];

export interface TelemetryEventDraft {
  readonly name: TelemetryEventName;
  readonly phase: JourneyPhase;
  readonly state: JourneyState;
  readonly origin_kind: TelemetryOriginKind;
  readonly first_observed_layer?: TelemetryOriginKind;
  readonly upstream_visibility?: TelemetryUpstreamVisibility;
  readonly parent_event_id?: string;
  readonly attributes?: TelemetryAttributes;
}

export interface JourneyTelemetryContext {
  readonly journeyId: string;
  readonly rootJourneyId: string;
  readonly traceparent: string;
  readonly tracestate?: string;
}

export interface JourneyIntakeEvent {
  readonly event_id: string;
  readonly journey_id: string;
  readonly sequence: number;
  readonly occurred_at: string;
  readonly name: TelemetryEventName;
  readonly phase: JourneyPhase;
  readonly state: JourneyState;
  readonly origin_kind: TelemetryOriginKind;
  readonly first_observed_layer: TelemetryOriginKind;
  readonly upstream_visibility: TelemetryUpstreamVisibility;
  readonly parent_event_id?: string;
  readonly trace_id?: string;
  readonly span_id?: string;
  readonly traceparent?: string;
  readonly tracestate?: string;
  readonly attributes?: TelemetryAttributes;
}

export interface JourneyIntakeResponse {
  readonly accepted_count: number;
  readonly duplicate_count: number;
}
