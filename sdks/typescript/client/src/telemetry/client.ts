import { normalizeTelemetryAttributes } from "./attributes";
import { TelemetryDelivery, type TelemetryExporterHealth, type TelemetryTimelineEntry } from "./delivery";
import { createJourneyIntakeExporter, MAX_JOURNEY_INTAKE_EVENTS_PER_BATCH, type TelemetryExporter, type TelemetryExportOptions } from "./exporter";
import { TelemetryJourney, type StartJourneyOptions } from "./journey";
import { createUuid } from "./random";
import type { TelemetryStorage } from "./storage";
import { createTraceContext, traceContextFromJourney } from "./trace";
import { TELEMETRY_EVENT_VERSION, type JourneyTelemetryContext, type TelemetryEvent, type TelemetryEventDraft } from "./types";

export type { TelemetryExporterHealth, TelemetryTimelineEntry } from "./delivery";
export { createJourneyIntakeExporter, toJourneyIntakeEvent } from "./exporter";
export type { JourneyIntakeExporterOptions, TelemetryExporter, TelemetryExportOptions } from "./exporter";
export { TelemetryJourney } from "./journey";
export type { DiagnosticObservation, HttpRequestObservation, StartJourneyOptions, SyncFrameObservation } from "./journey";

const DEFAULT_BATCH_SIZE = 25;
const DEFAULT_QUEUE_SIZE = 500;
const DEFAULT_TIMELINE_SIZE = 100;
const DEFAULT_RETRY_DELAY_MS = 2_000;

export interface TelemetryClientOptions {
  /** Telemetry remains inert until a first-party surface explicitly sets this to true. */
  readonly enabled?: boolean;
  readonly baseUrl?: string | URL;
  readonly credentials?: RequestCredentials;
  readonly exporter?: TelemetryExporter;
  readonly exporterPath?: string;
  readonly fetch?: typeof globalThis.fetch;
  /** Caps each request at 100 events, the v1 journey intake limit. */
  readonly maxBatchSize?: number;
  readonly maxQueueSize?: number;
  readonly maxTimelineEntries?: number;
  readonly now?: () => Date;
  readonly onDrop?: (droppedEvents: readonly TelemetryEvent[]) => void;
  readonly retryDelayMs?: number;
  readonly storage?: TelemetryStorage;
}

export class TelemetryClient {
  readonly enabled: boolean;
  private readonly delivery: TelemetryDelivery;
  private readonly now: () => Date;

  constructor(options: TelemetryClientOptions = {}) {
    const { enabled = false, now = () => new Date() } = options;
    this.enabled = enabled;
    this.now = now;
    this.delivery = new TelemetryDelivery({
      batchSize: Math.min(positiveInteger(options.maxBatchSize, DEFAULT_BATCH_SIZE), MAX_JOURNEY_INTAKE_EVENTS_PER_BATCH),
      enabled,
      exporter: resolveExporter(options),
      maxQueueSize: positiveInteger(options.maxQueueSize, DEFAULT_QUEUE_SIZE),
      maxTimelineEntries: positiveInteger(options.maxTimelineEntries, DEFAULT_TIMELINE_SIZE),
      onDrop: options.onDrop,
      retryDelayMs: positiveInteger(options.retryDelayMs, DEFAULT_RETRY_DELAY_MS),
      storage: options.storage,
    });
  }

  startJourney(options: StartJourneyOptions): TelemetryJourney {
    const parentContext = telemetryParentContext(options.parent);
    const trace = journeyTrace(options, parentContext);
    const journeyId = journeyIdentifier(options.journeyId);
    const journey = new TelemetryJourney(this, journeyContext(journeyId, trace, parentContext));
    const parentEventId = linkParentJourney(options.parent, journey.context);
    journey.start(options.kind, options.attributes, parentEventId);
    return journey;
  }

  getExporterHealth(): TelemetryExporterHealth {
    return this.delivery.getHealth();
  }

  getTimeline(): readonly TelemetryTimelineEntry[] {
    return this.delivery.getTimeline();
  }

  getPendingEvents(): readonly TelemetryEvent[] {
    return this.delivery.getPendingEvents();
  }

  subscribeExporterHealth(listener: (health: TelemetryExporterHealth) => void): () => void {
    return this.delivery.subscribe(listener);
  }

  flush(options?: TelemetryExportOptions): Promise<void> {
    return this.delivery.flush(options);
  }

  dispose(): void {
    this.delivery.dispose();
  }

  /** Internal for TelemetryJourney. Event construction remains synchronous and never waits for storage or network I/O. */
  emit(context: JourneyTelemetryContext, sequence: number, draft: TelemetryEventDraft): TelemetryEvent {
    const trace = traceContextFromJourney(context);
    const event: Record<string, unknown> = {
      version: TELEMETRY_EVENT_VERSION,
      event_id: createUuid(),
      journey_id: context.journeyId,
      sequence,
      occurred_at: this.now().toISOString(),
      name: draft.name,
      phase: draft.phase,
      state: draft.state,
      origin_kind: draft.origin_kind,
      first_observed_layer: draft.first_observed_layer || draft.origin_kind,
      upstream_visibility: draft.upstream_visibility || "local",
      trace_id: trace.traceId,
      span_id: trace.spanId,
      traceparent: context.traceparent,
    };
    assignDefined(event, "tracestate", context.tracestate);
    assignDefined(event, "parent_event_id", draft.parent_event_id);
    assignDefined(event, "attributes", normalizeTelemetryAttributes(draft.attributes));
    this.delivery.enqueue(event as unknown as TelemetryEvent);
    return event as unknown as TelemetryEvent;
  }
}

export function createTelemetryClient(options: TelemetryClientOptions = {}): TelemetryClient {
  return new TelemetryClient(options);
}

function resolveExporter(options: TelemetryClientOptions): TelemetryExporter | undefined {
  if (options.exporter) return options.exporter;
  if (!options.baseUrl) return undefined;
  return createJourneyIntakeExporter({ baseUrl: options.baseUrl, credentials: options.credentials, fetch: options.fetch, path: options.exporterPath });
}

function journeyContext(journeyId: string, trace: ReturnType<typeof createTraceContext>, parent: JourneyTelemetryContext | undefined): JourneyTelemetryContext {
  const context: Record<string, string> = {
    journeyId,
    rootJourneyId: parent?.rootJourneyId ?? journeyId,
    traceparent: trace.traceparent,
  };
  assignDefined(context, "tracestate", trace.tracestate);
  return context as unknown as JourneyTelemetryContext;
}

function telemetryParentContext(parent: TelemetryJourney | undefined): JourneyTelemetryContext | undefined {
  return parent ? parent.context : undefined;
}

function journeyTrace(options: StartJourneyOptions, parent: JourneyTelemetryContext | undefined) {
  return createTraceContext(parent ? parent.traceparent : options.traceparent, parent ? parent.tracestate : options.tracestate);
}

function journeyIdentifier(requested: string | undefined): string {
  return requested && validJourneyIdentifier(requested) ? requested.toLowerCase() : createUuid();
}

function validJourneyIdentifier(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value) && value.replaceAll("0", "").replaceAll("-", "") !== "";
}

function linkParentJourney(parent: TelemetryJourney | undefined, child: JourneyTelemetryContext): string | undefined {
  return parent ? parent.linkChild(child) : undefined;
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback;
}

function assignDefined(target: object, key: string, value: unknown): void {
  if (value !== undefined) (target as Record<string, unknown>)[key] = value;
}
