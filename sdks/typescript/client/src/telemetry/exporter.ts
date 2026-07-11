import type { JourneyIntakeEvent, JourneyIntakeResponse, TelemetryEvent } from "./types";

export interface JourneyIntakeExporterOptions {
  readonly baseUrl: string | URL;
  readonly credentials?: RequestCredentials;
  readonly fetch?: typeof globalThis.fetch;
  readonly headers?: Readonly<Record<string, string>> | (() => Readonly<Record<string, string>> | Promise<Readonly<Record<string, string>>>);
  readonly path?: string;
}

export interface TelemetryExportOptions {
  /** Keeps a browser request eligible to complete while the page is unloading. */
  readonly keepalive?: boolean;
}

/** Reserves headroom below the browser's 64 KiB aggregate quota for a concurrent terminal event. */
export const MAX_KEEPALIVE_BODY_BYTES = 48 * 1024;

/** Matches the v1 journey intake API's maximum events per request. */
export const MAX_JOURNEY_INTAKE_EVENTS_PER_BATCH = 100;

/** Matches the v1 journey intake API's 1 MiB request-body limit. */
export const MAX_JOURNEY_INTAKE_BODY_BYTES = 1024 * 1024;

/** Reserves 64 KiB below the API request-body limit for request-processing headroom. */
export const MAX_JOURNEY_INTAKE_BATCH_BODY_BYTES = MAX_JOURNEY_INTAKE_BODY_BYTES - 64 * 1024;

export type TelemetryExporter = (events: readonly JourneyIntakeEvent[], options?: TelemetryExportOptions) => Promise<JourneyIntakeResponse | void>;

export class TelemetryExportError extends Error {
  readonly retriable: boolean;
  readonly status: number;

  constructor(status: number) {
    super(`Journey telemetry export failed with HTTP ${status}`);
    this.name = "TelemetryExportError";
    this.status = status;
    this.retriable = status === 408 || status === 429 || status >= 500;
  }
}

export function isRetriableTelemetryExportError(error: unknown): boolean {
  if (error instanceof TelemetryExportError || error instanceof TelemetryPayloadTooLargeError) return error.retriable;
  return true;
}

export function createJourneyIntakeExporter(options: JourneyIntakeExporterOptions): TelemetryExporter {
  const fetchImplementation = options.fetch || globalThis.fetch;
  const endpoint = new URL(options.path || "/v1/telemetry/journey-events", options.baseUrl).toString();

  return (events, exportOptions) => exportJourneyIntake(events, exportOptions, endpoint, fetchImplementation, options);
}

async function exportJourneyIntake(events: readonly JourneyIntakeEvent[], exportOptions: TelemetryExportOptions | undefined, endpoint: string, fetchImplementation: typeof globalThis.fetch, options: JourneyIntakeExporterOptions): Promise<JourneyIntakeResponse> {
  const batches = journeyContextBatches(events).flatMap((batch) => eventBatches(batch));
  if (batches.length === 0) return exportJourneyIntakeBatch(events, exportOptions, endpoint, fetchImplementation, options);

  const responses = await Promise.all(batches.map((batch) => exportJourneyIntakeBatch(batch, exportOptions, endpoint, fetchImplementation, options)));
  return responses.reduce((total, response) => ({ accepted_count: total.accepted_count + response.accepted_count, duplicate_count: total.duplicate_count + response.duplicate_count }), { accepted_count: 0, duplicate_count: 0 });
}

function eventBatches(events: readonly JourneyIntakeEvent[]): JourneyIntakeEvent[][] {
  const batches: JourneyIntakeEvent[][] = [];
  let batch: JourneyIntakeEvent[] = [];

  for (const event of events) {
    if (batch.length === 0) {
      batch = [event];
      continue;
    }
    if (batch.length === MAX_JOURNEY_INTAKE_EVENTS_PER_BATCH || !journeyIntakeBodyFits([...batch, event])) {
      batches.push(batch);
      batch = [event];
      continue;
    }
    batch.push(event);
  }

  if (batch.length > 0) batches.push(batch);
  return batches;
}

function journeyIntakeBodyFits(events: readonly JourneyIntakeEvent[]): boolean {
  return encodedByteLength(journeyIntakeBody(events)) <= MAX_JOURNEY_INTAKE_BATCH_BODY_BYTES;
}

async function exportJourneyIntakeBatch(events: readonly JourneyIntakeEvent[], exportOptions: TelemetryExportOptions | undefined, endpoint: string, fetchImplementation: typeof globalThis.fetch, options: JourneyIntakeExporterOptions): Promise<JourneyIntakeResponse> {
  const body = journeyIntakeBody(events);
  assertKeepaliveBodySize(body, exportOptions);
  const headers = await resolveExporterHeaders(options.headers);
  const response = await fetchImplementation(endpoint, journeyIntakeRequest(events, body, headers, options.credentials, exportOptions));
  if (!response.ok) throw new TelemetryExportError(response.status);
  return intakeResponse(await response.json().catch(emptyIntakeResponse), events.length);
}

function assertKeepaliveBodySize(body: string, options: TelemetryExportOptions | undefined): void {
  if (options?.keepalive && encodedByteLength(body) > MAX_KEEPALIVE_BODY_BYTES) throw new TelemetryPayloadTooLargeError();
}

function journeyIntakeRequest(events: readonly JourneyIntakeEvent[], body: string, headers: Readonly<Record<string, string>> | undefined, credentials: RequestCredentials | undefined, options: TelemetryExportOptions | undefined): RequestInit {
  return {
    method: "POST",
    credentials,
    headers: { Accept: "application/json", "Content-Type": "application/json", ...headers, ...journeyIntakeHeaders(events) },
    body,
    keepalive: options?.keepalive,
  };
}

export class TelemetryPayloadTooLargeError extends Error {
  readonly retriable = false;

  constructor() {
    super(`Journey telemetry keepalive payload exceeds ${MAX_KEEPALIVE_BODY_BYTES} bytes`);
    this.name = "TelemetryPayloadTooLargeError";
  }
}

export function toJourneyIntakeEvent(event: TelemetryEvent): JourneyIntakeEvent {
  const { version: _version, ...intakeEvent } = event;
  return intakeEvent;
}

async function resolveExporterHeaders(headers: JourneyIntakeExporterOptions["headers"]): Promise<Readonly<Record<string, string>> | undefined> {
  return typeof headers === "function" ? headers() : headers;
}

function journeyIntakeHeaders(events: readonly JourneyIntakeEvent[]): Record<string, string> {
  const firstEvent = events[0];
  if (!firstEvent) return {};

  const headers: Record<string, string> = {
    "x-chalk-journey-id": firstEvent.journey_id,
  };
  const traceparent = eventTraceparent(firstEvent);
  if (traceparent) headers.traceparent = traceparent;
  if (firstEvent.tracestate) headers.tracestate = firstEvent.tracestate;
  return headers;
}

export function journeyContextBatches<TEvent extends Pick<JourneyIntakeEvent, "journey_id" | "traceparent" | "tracestate">>(events: readonly TEvent[]): TEvent[][] {
  const batches: TEvent[][] = [];
  for (const event of events) {
    const batch = batches.find(([firstEvent]) => firstEvent !== undefined && sharesJourneyContext(firstEvent, event));
    if (batch) batch.push(event);
    else batches.push([event]);
  }
  return batches;
}

export function sharesJourneyContext(left: Pick<JourneyIntakeEvent, "journey_id" | "traceparent" | "tracestate">, right: Pick<JourneyIntakeEvent, "journey_id" | "traceparent" | "tracestate">): boolean {
  return left.journey_id === right.journey_id && left.traceparent === right.traceparent && left.tracestate === right.tracestate;
}

function emptyIntakeResponse(): Partial<JourneyIntakeResponse> {
  return {};
}

function intakeResponse(body: unknown, eventCount: number): JourneyIntakeResponse {
  const candidate = body as Partial<JourneyIntakeResponse>;
  return {
    accepted_count: candidate.accepted_count ?? eventCount,
    duplicate_count: candidate.duplicate_count ?? 0,
  };
}

function eventTraceparent(event: JourneyIntakeEvent): string | undefined {
  return event.traceparent;
}

function apiJourneyIntakeEvent(event: JourneyIntakeEvent): Omit<JourneyIntakeEvent, "traceparent" | "tracestate"> {
  const { traceparent: _traceparent, tracestate: _tracestate, ...apiEvent } = event;
  return apiEvent;
}

export function journeyIntakeBody(events: readonly JourneyIntakeEvent[]): string {
  return JSON.stringify({ events: events.map(apiJourneyIntakeEvent) });
}

export function encodedByteLength(value: string): number {
  return new Blob([value]).size;
}
