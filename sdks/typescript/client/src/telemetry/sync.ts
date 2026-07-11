import type { JourneyTelemetryContext } from "./types";

export interface SyncTelemetryCorrelation {
  readonly journey_id: string;
  readonly traceparent: string;
  readonly tracestate?: string;
}

/** Adds the v1 optional correlation fields accepted by the sync hello frame without changing application frame fields. */
export function withSyncTelemetryCorrelation<TFrame extends object>(frame: TFrame, context: JourneyTelemetryContext): TFrame & SyncTelemetryCorrelation {
  return {
    ...frame,
    journey_id: context.journeyId,
    traceparent: context.traceparent,
    ...(context.tracestate ? { tracestate: context.tracestate } : {}),
  };
}

export function syncTelemetryCorrelation(context: JourneyTelemetryContext): SyncTelemetryCorrelation {
  return withSyncTelemetryCorrelation({}, context);
}
