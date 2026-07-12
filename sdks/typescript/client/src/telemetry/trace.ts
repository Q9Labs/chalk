import type { JourneyTelemetryContext } from "./types";
import { randomHex } from "./random";

export const CHALK_JOURNEY_ID_HEADER = "x-chalk-journey-id";
export const TRACEPARENT_HEADER = "traceparent";
export const TRACESTATE_HEADER = "tracestate";

export type TraceContext = {
  readonly traceId: string;
  readonly spanId: string;
  readonly traceFlags: string;
  readonly traceparent: string;
  readonly tracestate?: string;
};

type ParsedTraceparent = Omit<TraceContext, "traceparent" | "tracestate">;

const traceparentPattern = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/i;

export function createTraceContext(parentTraceparent?: string, tracestate?: string): TraceContext {
  const parent = parseTraceparent(parentTraceparent);
  const traceId = parent?.traceId ?? randomHex(16);
  const spanId = randomHex(8);
  const traceFlags = parent?.traceFlags ?? "01";

  return {
    traceId,
    spanId,
    traceFlags,
    traceparent: `00-${traceId}-${spanId}-${traceFlags}`,
    ...(tracestate ? { tracestate } : {}),
  };
}

export function parseTraceparent(value: string | undefined): ParsedTraceparent | undefined {
  if (!value) {
    return undefined;
  }

  return parseTraceparentMatch(traceparentPattern.exec(value));
}

function parseTraceparentMatch(match: RegExpExecArray | null): ParsedTraceparent | undefined {
  if (!match) return undefined;
  const traceId = match[1];
  const spanId = match[2];
  const traceFlags = match[3];
  if (!traceId || !spanId || !traceFlags || /^0+$/.test(traceId) || /^0+$/.test(spanId)) return undefined;

  return {
    traceId: traceId.toLowerCase(),
    spanId: spanId.toLowerCase(),
    traceFlags: traceFlags.toLowerCase(),
  };
}

export function journeyHeaders(context: JourneyTelemetryContext): Record<string, string> {
  return {
    [CHALK_JOURNEY_ID_HEADER]: context.journeyId,
    [TRACEPARENT_HEADER]: context.traceparent,
    ...(context.tracestate ? { [TRACESTATE_HEADER]: context.tracestate } : {}),
  };
}

export function traceContextFromJourney(context: JourneyTelemetryContext): TraceContext {
  const parsed = parseTraceparent(context.traceparent);
  if (!parsed) {
    return createTraceContext(undefined, context.tracestate);
  }

  return {
    ...parsed,
    traceparent: context.traceparent,
    ...(context.tracestate ? { tracestate: context.tracestate } : {}),
  };
}
