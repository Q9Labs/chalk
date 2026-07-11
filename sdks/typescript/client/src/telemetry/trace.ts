import type { JourneyTelemetryContext } from "./types";
import { randomHex } from "./random";

export const CHALK_JOURNEY_ID_HEADER = "x-chalk-journey-id";
export const TRACEPARENT_HEADER = "traceparent";
export const TRACESTATE_HEADER = "tracestate";

export interface TraceContext {
  readonly traceId: string;
  readonly spanId: string;
  readonly traceFlags: string;
  readonly traceparent: string;
  readonly tracestate?: string;
}

const traceparentPattern = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/i;

export function createTraceContext(parentTraceparent?: string, tracestate?: string): TraceContext {
  const parent = parseTraceparent(parentTraceparent);
  const traceId = parentTraceID(parent);
  const spanId = randomHex(8);
  const traceFlags = parentTraceFlags(parent);

  return attachTracestate(
    {
      traceId,
      spanId,
      traceFlags,
      traceparent: `00-${traceId}-${spanId}-${traceFlags}`,
    },
    tracestate,
  );
}

export function parseTraceparent(value: string | undefined): Omit<TraceContext, "traceparent" | "tracestate"> | undefined {
  if (!value) {
    return undefined;
  }

  return parseTraceparentMatch(traceparentPattern.exec(value));
}

function parseTraceparentMatch(match: RegExpExecArray | null): Omit<TraceContext, "traceparent" | "tracestate"> | undefined {
  if (!match) return undefined;
  const [, traceId, spanId, traceFlags] = match;
  if (/^0+$/.test(traceId!) || /^0+$/.test(spanId!)) return undefined;

  return {
    traceId: traceId!.toLowerCase(),
    spanId: spanId!.toLowerCase(),
    traceFlags: traceFlags!.toLowerCase(),
  };
}

export function journeyHeaders(context: JourneyTelemetryContext): Record<string, string> {
  return attachTracestate(
    {
      [CHALK_JOURNEY_ID_HEADER]: context.journeyId,
      [TRACEPARENT_HEADER]: context.traceparent,
    },
    context.tracestate,
    TRACESTATE_HEADER,
  );
}

export function traceContextFromJourney(context: JourneyTelemetryContext): TraceContext {
  const parsed = parseTraceparent(context.traceparent);
  if (!parsed) {
    return createTraceContext(undefined, context.tracestate);
  }

  return attachTracestate(
    {
      ...parsed,
      traceparent: context.traceparent,
    },
    context.tracestate,
  );
}

function parentTraceID(parent: ReturnType<typeof parseTraceparent>): string {
  return parent ? parent.traceId : randomHex(16);
}

function parentTraceFlags(parent: ReturnType<typeof parseTraceparent>): string {
  return parent ? parent.traceFlags : "01";
}

function attachTracestate<T extends Record<string, string>>(target: T, tracestate: string | undefined, key = "tracestate"): T {
  if (tracestate) (target as Record<string, string>)[key] = tracestate;
  return target;
}
