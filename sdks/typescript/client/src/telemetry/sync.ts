import type { JourneyTelemetryContext } from "./types";

// The v1 wire contract currently accepts a strict tracestate subset. Keep the
// journey and traceparent fields when an upstream W3C value falls outside that
// subset; sending it would make the sync server reject the entire hello.
const syncTracestatePattern = /^[a-z][a-z0-9_*\/-]{0,255}=[\x21-\x2b\x2d-\x3c\x3e-\x7e]{1,256}(,[a-z][a-z0-9_*\/-]{0,255}=[\x21-\x2b\x2d-\x3c\x3e-\x7e]{1,256})*$/u;
const syncTracestateEncoder = new TextEncoder();

export type SyncTelemetryCorrelation = {
  readonly journey_id: string;
  readonly traceparent: string;
  readonly tracestate?: string;
};

function supportedSyncTracestate(value: string): boolean {
  const bytes = syncTracestateEncoder.encode(value).byteLength;
  return bytes >= 1 && bytes <= 512 && syncTracestatePattern.test(value);
}

/** Adds the v1 optional correlation fields accepted by the sync hello frame without changing application frame fields. */
export function withSyncTelemetryCorrelation<TFrame extends object>(frame: TFrame, context: JourneyTelemetryContext): TFrame & SyncTelemetryCorrelation {
  return {
    ...frame,
    journey_id: context.journeyId,
    traceparent: context.traceparent,
    ...(context.tracestate && supportedSyncTracestate(context.tracestate) ? { tracestate: context.tracestate } : {}),
  };
}

export function syncTelemetryCorrelation(context: JourneyTelemetryContext): SyncTelemetryCorrelation {
  return withSyncTelemetryCorrelation({}, context);
}
