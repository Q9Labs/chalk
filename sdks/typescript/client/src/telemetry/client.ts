import { Effect, Layer, ManagedRuntime } from "effect";
import { normalizeTelemetryAttributes } from "./attributes";
import { TelemetryDeliveryService, makeTelemetryDeliveryLayer, type TelemetryDeliveryEffectService, type TelemetryExporterHealth, type TelemetryTimelineEntry } from "./delivery";
import { createJourneyIntakeExporter, MAX_JOURNEY_INTAKE_EVENTS_PER_BATCH, type TelemetryExporter, type TelemetryExportOptions } from "./exporter";
import { TelemetryJourney, type StartJourneyOptions } from "./journey";
import { TelemetryEventSourceService, makeTelemetryEventSourceLayer, type TelemetryEventSource } from "./random";
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

export type TelemetryClientOptions = {
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
};

const journeyIdentifierPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class TelemetryClient {
  readonly enabled: boolean;
  readonly #delivery: TelemetryDeliveryEffectService;
  readonly #eventSource: TelemetryEventSource;
  readonly #ready: Promise<void>;
  readonly #runtime: ManagedRuntime.ManagedRuntime<TelemetryDeliveryService | TelemetryEventSourceService, never>;
  #disposePromise: Promise<void> | undefined;

  constructor(options: TelemetryClientOptions = {}) {
    const { enabled = false } = options;
    this.enabled = enabled;
    const deliveryOptions = {
      batchSize: Math.min(positiveInteger(options.maxBatchSize, DEFAULT_BATCH_SIZE), MAX_JOURNEY_INTAKE_EVENTS_PER_BATCH),
      enabled,
      exporter: resolveExporter(options),
      maxQueueSize: positiveInteger(options.maxQueueSize, DEFAULT_QUEUE_SIZE),
      maxTimelineEntries: positiveInteger(options.maxTimelineEntries, DEFAULT_TIMELINE_SIZE),
      onDrop: options.onDrop,
      retryDelayMs: positiveInteger(options.retryDelayMs, DEFAULT_RETRY_DELAY_MS),
      storage: options.storage,
    };
    this.#runtime = ManagedRuntime.make(Layer.mergeAll(makeTelemetryDeliveryLayer(deliveryOptions), makeTelemetryEventSourceLayer(options.now)));
    this.#delivery = this.#runtime.runSync(Effect.service(TelemetryDeliveryService));
    this.#eventSource = this.#runtime.runSync(Effect.service(TelemetryEventSourceService));
    this.#ready = this.#runtime.runPromiseExit(this.#delivery.awaitReady()).then(() => undefined);
  }

  startJourney(options: StartJourneyOptions): TelemetryJourney {
    const parentContext = options.parent?.context;
    const trace = createTraceContext(parentContext?.traceparent ?? options.traceparent, parentContext?.tracestate ?? options.tracestate);
    const journeyId = options.journeyId && validJourneyIdentifier(options.journeyId) ? options.journeyId.toLowerCase() : this.#eventSource.createUuid();
    const journey = new TelemetryJourney(this, {
      journeyId,
      rootJourneyId: parentContext?.rootJourneyId ?? journeyId,
      traceparent: trace.traceparent,
      ...(trace.tracestate ? { tracestate: trace.tracestate } : {}),
    });
    const parentEventId = options.parent?.linkChild(journey.context);
    journey.start(options.kind, options.attributes, parentEventId);
    return journey;
  }

  getExporterHealth(): TelemetryExporterHealth {
    return this.#delivery.getHealthUnsafe();
  }

  getTimeline(): readonly TelemetryTimelineEntry[] {
    return this.#delivery.getTimelineUnsafe();
  }

  getPendingEvents(): readonly TelemetryEvent[] {
    return this.#delivery.getPendingEventsUnsafe();
  }

  subscribeExporterHealth(listener: (health: TelemetryExporterHealth) => void): () => void {
    return this.#delivery.subscribe(listener);
  }

  async flush(options?: TelemetryExportOptions): Promise<void> {
    if (this.#disposePromise) return this.#disposePromise;
    await this.#ready;
    if (this.#disposePromise) return this.#disposePromise;
    await this.#runtime.runPromise(this.#delivery.flush(options));
  }

  dispose(): void {
    if (this.#disposePromise) return;
    Effect.runSync(this.#delivery.dispose());
    this.#disposePromise = this.#runtime.dispose();
  }

  /** Internal for TelemetryJourney. Event construction remains synchronous and never waits for storage or network I/O. */
  emit(context: JourneyTelemetryContext, sequence: number, draft: TelemetryEventDraft): TelemetryEvent {
    const trace = traceContextFromJourney(context);
    const { attributes: draftAttributes, ...eventDraft } = draft;
    const attributes = normalizeTelemetryAttributes(draftAttributes);
    const event: TelemetryEvent = {
      ...eventDraft,
      version: TELEMETRY_EVENT_VERSION,
      event_id: this.#eventSource.createUuid(),
      journey_id: context.journeyId,
      sequence,
      occurred_at: this.#eventSource.now().toISOString(),
      first_observed_layer: eventDraft.first_observed_layer || eventDraft.origin_kind,
      upstream_visibility: eventDraft.upstream_visibility || "local",
      trace_id: trace.traceId,
      span_id: trace.spanId,
      traceparent: context.traceparent,
      ...(context.tracestate ? { tracestate: context.tracestate } : {}),
      ...(attributes ? { attributes } : {}),
    };
    const flushNow = this.#delivery.enqueueUnsafe(event);
    void this.#runtime.runPromiseExit(flushNow ? this.#delivery.flush() : this.#delivery.persist());
    return event;
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

function validJourneyIdentifier(value: string): boolean {
  return journeyIdentifierPattern.test(value) && value.replaceAll("0", "").replaceAll("-", "") !== "";
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback;
}
