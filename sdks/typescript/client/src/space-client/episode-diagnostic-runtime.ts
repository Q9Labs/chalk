import { encodedEventSize, getActionContract, parseDiagnosticEventDraft, redactDiagnosticAttributes, type DiagnosticAttributes, type DiagnosticEventCorrelation, type DiagnosticEventDraft, type DiagnosticEventState, type DiagnosticRelease } from "@q9labsai/diagnostics-contracts";
import { parseEpisodeDiagnosticCredential, validEpisodeDiagnosticCredential, type EpisodeDiagnosticCredential } from "../access/episode-diagnostic-credential";
import { createTraceContext, parseTraceparent } from "../telemetry/trace";

const DEFAULT_RING_EVENTS = 256;
const DEFAULT_RING_BYTES = 256 * 1024;
const DEFAULT_RING_AGE_MS = 2 * 60 * 1000;
const DEFAULT_QUEUE_EVENTS = 128;
const DEFAULT_QUEUE_BYTES = 128 * 1024;
const DEFAULT_QUEUE_AGE_MS = 60 * 1000;
const DEFAULT_BATCH_EVENTS = 25;
const DEFAULT_BATCH_BYTES = 32 * 1024;
const DEFAULT_RETRY_ATTEMPTS = 3;
const DEFAULT_RETRY_DELAY_MS = 500;
const TERMINAL_CHECKPOINT_OVERRIDES: Readonly<Record<string, string>> = { "chat.send": "sender_receipt", "chat.retry": "sender_receipt", "reaction.send": "sender_result" };

export type EpisodeDiagnosticRuntimeOptions = Readonly<{
  apiBaseUrl: string;
  createId: () => string;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
  setTimeout?: (callback: () => void, milliseconds: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
  journeyId?: string;
  traceparent?: string;
  tracestate?: string;
  maxRingEvents?: number;
  maxRingBytes?: number;
  maxRingAgeMs?: number;
  maxQueueEvents?: number;
  maxQueueBytes?: number;
  maxQueueAgeMs?: number;
  maxBatchEvents?: number;
  maxBatchBytes?: number;
  maxRetryAttempts?: number;
  retryDelayMs?: number;
  release?: DiagnosticRelease;
  exporter?: EpisodeDiagnosticExporter;
}>;

export type EpisodeDiagnosticDeliveryResult = Readonly<{
  accepted: readonly string[];
  duplicates: readonly string[];
  conflicts: readonly string[];
}>;

export type EpisodeDiagnosticExporter = (
  request: Readonly<{
    endpoint: string;
    token: string;
    signal: AbortSignal;
    body: Readonly<{
      version: 1;
      producer: Readonly<{ id: "sdk"; instanceId: string; generation: number }>;
      events: readonly DiagnosticEventDraft[];
    }>;
  }>,
) => Promise<EpisodeDiagnosticDeliveryResult | void>;

export type EpisodeDiagnosticCorrelationInput = Readonly<{
  journeyId?: string;
  traceId?: string;
  spanId?: string;
  requestId?: string;
  commandId?: string;
  retryGroupRef?: string;
  attempt?: number;
  provider?: Readonly<{ value: string; storage: "hmac" }>;
}>;

export type EpisodeDiagnosticObservation = Readonly<{
  name: string;
  phase: string;
  state: DiagnosticEventState;
  operationRef?: string;
  parentOperationRef?: string;
  checkpoint?: string;
  attributes?: Readonly<Record<string, unknown>>;
  correlation?: EpisodeDiagnosticCorrelationInput;
}>;

export type EpisodeDiagnosticOperation = Readonly<{
  ref: string;
  observe: (phase: string, checkpoint: string, attributes?: Readonly<Record<string, unknown>>) => void;
  succeed: (attributes?: Readonly<Record<string, unknown>>) => void;
  fail: (reason?: string) => void;
  notObservable: (checkpoint: string, reason?: string) => void;
}>;

type BufferedEvent = Readonly<{ event: DiagnosticEventDraft; bytes: number; observedAt: number; credentialGeneration: number }>;
type DeliveryAttempt = Readonly<{ result?: EpisodeDiagnosticDeliveryResult; attempted: boolean; cancelled: boolean }>;
type IntakeResponse = Readonly<{ accepted: readonly unknown[]; duplicates: readonly unknown[]; conflicts: readonly unknown[] }>;
type DraftContext = Readonly<{ eventId: string; producerSequence: number; occurredAt: string; journeyId: string; traceparent: string; release?: DiagnosticRelease }>;

/** Private, framework-neutral semantic diagnostics. It never owns or gates product work. */
export class EpisodeDiagnosticRuntime {
  readonly #apiBaseUrl: string;
  readonly #instanceId: string;
  readonly #createId: () => string;
  readonly #fetch: typeof globalThis.fetch | undefined;
  readonly #now: () => number;
  readonly #setTimeout: (callback: () => void, milliseconds: number) => unknown;
  readonly #clearTimeout: (handle: unknown) => void;
  readonly #exporter: EpisodeDiagnosticExporter;
  readonly #journeyId: string;
  readonly #traceparent: string;
  readonly #tracestate: string | undefined;
  readonly #maxRingEvents: number;
  readonly #maxRingBytes: number;
  readonly #maxRingAgeMs: number;
  readonly #maxQueueEvents: number;
  readonly #maxQueueBytes: number;
  readonly #maxQueueAgeMs: number;
  readonly #maxBatchEvents: number;
  readonly #maxBatchBytes: number;
  readonly #maxRetryAttempts: number;
  readonly #retryDelayMs: number;
  readonly #release: DiagnosticRelease | undefined;
  readonly #ring: BufferedEvent[] = [];
  readonly #queue: BufferedEvent[] = [];
  readonly #quarantine: BufferedEvent[] = [];
  #ringBytes = 0;
  #queueBytes = 0;
  #quarantineBytes = 0;
  #sequence = 0;
  #credential: EpisodeDiagnosticCredential | null = null;
  #credentialEpoch = 0;
  #captureEnabled = false;
  #timer: unknown;
  #retryTimer: unknown;
  #retryResolve: (() => void) | null = null;
  #activeExportController: AbortController | null = null;
  #flushing = false;
  #disposed = false;
  #pendingGapCount = 0;
  #pendingGapReason = "client_queue_overflow";

  constructor(options: EpisodeDiagnosticRuntimeOptions) {
    this.#apiBaseUrl = normalizedBaseUrl(options.apiBaseUrl);
    this.#createId = options.createId;
    this.#instanceId = safeId(options.createId());
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#now = options.now ?? Date.now;
    this.#setTimeout = options.setTimeout ?? ((callback, milliseconds) => globalThis.setTimeout(callback, milliseconds));
    this.#clearTimeout = options.clearTimeout ?? ((handle) => globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>));
    this.#exporter = options.exporter ?? ((request) => this.#export(request));
    this.#maxRingEvents = positive(options.maxRingEvents, DEFAULT_RING_EVENTS);
    this.#maxRingBytes = positive(options.maxRingBytes, DEFAULT_RING_BYTES);
    this.#maxRingAgeMs = positive(options.maxRingAgeMs, DEFAULT_RING_AGE_MS);
    this.#maxQueueEvents = positive(options.maxQueueEvents, DEFAULT_QUEUE_EVENTS);
    this.#maxQueueBytes = positive(options.maxQueueBytes, DEFAULT_QUEUE_BYTES);
    this.#maxQueueAgeMs = positive(options.maxQueueAgeMs, DEFAULT_QUEUE_AGE_MS);
    this.#maxBatchEvents = positive(options.maxBatchEvents, DEFAULT_BATCH_EVENTS);
    this.#maxBatchBytes = positive(options.maxBatchBytes, DEFAULT_BATCH_BYTES);
    this.#maxRetryAttempts = positive(options.maxRetryAttempts, DEFAULT_RETRY_ATTEMPTS);
    this.#retryDelayMs = positive(options.retryDelayMs, DEFAULT_RETRY_DELAY_MS);
    this.#release = safeRelease(options.release);
    this.#journeyId = safeCorrelation(options.journeyId) ?? safeId(options.createId());
    const trace = createTraceContext(options.traceparent, options.tracestate);
    this.#traceparent = trace.traceparent;
    this.#tracestate = trace.tracestate;
  }

  rotateCredential(credential: EpisodeDiagnosticCredential | null): void {
    try {
      if (this.#disposed) return;
      if (credential === null) {
        this.#disableCapture();
        return;
      }
      if (!validCredential(credential, this.#now())) {
        this.#disableCapture();
        return;
      }
      if (this.#credential && credential.generation < this.#credential.generation) return;
      this.#credential = Object.freeze({ ...credential });
      this.#captureEnabled = true;
      this.#emitPendingGap();
      this.#scheduleFlush(0);
    } catch {
      // Credential diagnostics never influence AccessGrant handling.
    }
  }

  context(operationRef?: string): Readonly<{ journeyId: string; traceparent: string; tracestate?: string; producerOperationRef?: string }> {
    return {
      journeyId: this.#journeyId,
      traceparent: this.#traceparent,
      ...(this.#tracestate ? { tracestate: this.#tracestate } : {}),
      ...(operationRef ? { producerOperationRef: operationRef } : {}),
    };
  }

  activeContext(): ReturnType<EpisodeDiagnosticRuntime["context"]> | undefined {
    return this.#enabled() ? this.context() : undefined;
  }

  /** Internal Feedback seam. It returns only a short-lived verified credential to the private transport. */
  feedbackCredentialUnsafe(): EpisodeDiagnosticCredential | null {
    if (!this.#enabled() || !this.#credential) return null;
    return Object.freeze({ ...this.#credential });
  }

  feedbackAvailabilityUnsafe(): "available" | "disabled" | "disposed" | "unavailable" {
    if (this.#disposed) return "disposed";
    return this.#enabled() ? "available" : "disabled";
  }

  startOperation(name: string, attributes?: Readonly<Record<string, unknown>>, parentOperationRef?: string, producerOperationRef?: string, correlationInput?: EpisodeDiagnosticCorrelationInput): EpisodeDiagnosticOperation | undefined {
    if (!this.#enabled()) return undefined;
    const credentialGeneration = this.#credential?.generation;
    if (credentialGeneration === undefined) return undefined;
    const credentialEpoch = this.#credentialEpoch;
    const ref = safeId(producerOperationRef ?? this.#createId());
    const trace = createTraceContext(reconnectBoundary(name) ? undefined : this.#traceparent, this.#tracestate);
    const correlation = { journeyId: this.#journeyId, traceId: trace.traceId, spanId: trace.spanId, ...correlationInput };
    this.observe({ name, phase: "intent", state: "started", operationRef: ref, parentOperationRef, checkpoint: firstCheckpoint(name), attributes, correlation });
    let ended = false;
    const active = () => this.#enabled() && this.#credentialEpoch === credentialEpoch && this.#credential?.generation === credentialGeneration;
    const terminal = (state: "succeeded" | "failed", terminalAttributes?: Readonly<Record<string, unknown>>) => {
      if (ended || !active()) return;
      ended = true;
      this.observe({ name, phase: state, state, operationRef: ref, parentOperationRef, checkpoint: terminalCheckpoint(name), attributes: terminalAttributes, correlation });
    };
    return Object.freeze({
      ref,
      observe: (phase, checkpoint, observedAttributes) => {
        if (active()) this.observe({ name, phase, state: "observed", operationRef: ref, parentOperationRef, checkpoint, attributes: observedAttributes, correlation });
      },
      succeed: (terminalAttributes) => terminal("succeeded", terminalAttributes),
      fail: (reason) => terminal("failed", reason ? { reason: safeReason(reason) } : undefined),
      notObservable: (checkpoint, reason) => {
        if (active()) this.observe({ name, phase: "not_observable", state: "not_observable", operationRef: ref, parentOperationRef, checkpoint, attributes: reason ? { reason: safeReason(reason) } : undefined, correlation });
      },
    });
  }

  observe(input: EpisodeDiagnosticObservation): void {
    try {
      if (!this.#enabled()) return;
      this.#pruneExpired();
      this.#emitPendingGap();
      this.#enqueue(this.#draft(input));
      this.#scheduleFlush(0);
    } catch {
      this.#pendingGapCount = Math.min(Number.MAX_SAFE_INTEGER, this.#pendingGapCount + 1);
      this.#pendingGapReason = "client_event_rejected";
    }
  }

  observePromise<T>(operation: EpisodeDiagnosticOperation | undefined, promise: Promise<T>): Promise<T> {
    if (!operation) return promise;
    void promise.then(
      () => operation.succeed(),
      () => operation.fail("operation_failed"),
    );
    return promise;
  }

  dispose(): void {
    this.#disposed = true;
    this.#disableCapture();
    this.#flushing = false;
    this.#clearBuffers();
  }

  /** Internal deterministic proof seam; it is not exported by the package. */
  inspect(): Readonly<{ ring: readonly DiagnosticEventDraft[]; queue: readonly DiagnosticEventDraft[]; quarantine: readonly DiagnosticEventDraft[]; dropped: number; credentialGeneration: number | null }> {
    return Object.freeze({
      ring: Object.freeze(this.#ring.map(({ event }) => event)),
      queue: Object.freeze(this.#queue.map(({ event }) => event)),
      quarantine: Object.freeze(this.#quarantine.map(({ event }) => event)),
      dropped: this.#pendingGapCount,
      credentialGeneration: this.#credential?.generation ?? null,
    });
  }

  #draft(input: EpisodeDiagnosticObservation): DiagnosticEventDraft {
    return parseDiagnosticEventDraft(
      buildDraftInput(input, {
        eventId: safeId(this.#createId()),
        producerSequence: ++this.#sequence,
        occurredAt: new Date(this.#now()).toISOString(),
        journeyId: this.#journeyId,
        traceparent: this.#traceparent,
        release: this.#release,
      }),
    );
  }

  #enqueue(event: DiagnosticEventDraft): void {
    const buffered = { event, bytes: encodedEventSize(event), observedAt: this.#now(), credentialGeneration: this.#credential?.generation ?? 0 };
    this.#ring.push(buffered);
    this.#ringBytes += buffered.bytes;
    while (this.#ring.length > this.#maxRingEvents || this.#ringBytes > this.#maxRingBytes) {
      const removed = this.#ring.shift();
      if (removed) this.#ringBytes -= removed.bytes;
    }
    this.#queue.push(buffered);
    this.#queueBytes += buffered.bytes;
    while (this.#queue.length > this.#maxQueueEvents || this.#queueBytes > this.#maxQueueBytes) {
      const removed = this.#queue.shift();
      if (removed) {
        this.#queueBytes -= removed.bytes;
        this.#pendingGapCount += 1;
        this.#pendingGapReason = "client_queue_overflow";
      }
    }
  }

  #emitPendingGap(): void {
    if (this.#pendingGapCount === 0 || !this.#enabled()) return;
    const dropped = this.#pendingGapCount;
    const reason = this.#pendingGapReason;
    this.#pendingGapCount = 0;
    try {
      this.#enqueue(this.#draft({ name: "coverage.gap", phase: "observed", state: "observed", attributes: { reason, count: dropped } }));
    } catch {
      this.#pendingGapCount = dropped;
    }
  }

  #pruneExpired(): void {
    const now = this.#now();
    while (this.#ring[0] && now - this.#ring[0].observedAt > this.#maxRingAgeMs) {
      this.#ringBytes -= this.#ring.shift()!.bytes;
    }
    while (this.#queue[0] && now - this.#queue[0].observedAt > this.#maxQueueAgeMs) {
      this.#queueBytes -= this.#queue.shift()!.bytes;
      this.#pendingGapCount += 1;
      this.#pendingGapReason = "client_queue_expired";
    }
  }

  #scheduleFlush(delay: number): void {
    if (this.#timer !== undefined || this.#flushing || !this.#deliveryCredential() || this.#queue.length === 0) return;
    this.#timer = this.#setTimeout(() => {
      this.#timer = undefined;
      void this.#flush();
    }, delay);
  }

  async #flush(): Promise<void> {
    if (this.#flushing || !this.#enabled()) return;
    this.#pruneExpired();
    this.#emitPendingGap();
    if (!this.#deliveryCredential() || this.#queue.length === 0) return;
    const batch = takeBatch(this.#queue, this.#maxBatchEvents, this.#maxBatchBytes);
    if (batch.length === 0) return;
    this.#flushing = true;
    await this.#deliverBatch(batch);
    this.#flushing = false;
    this.#scheduleFlush(0);
  }

  async #deliverBatch(batch: readonly BufferedEvent[]): Promise<void> {
    let result: EpisodeDiagnosticDeliveryResult | undefined;
    let attempted = false;
    let cancelled = false;
    for (let attempt = 1; attempt <= this.#maxRetryAttempts; attempt += 1) {
      const delivery = await this.#deliverAttempt(batch, attempt);
      if (delivery.attempted) attempted = true;
      if (delivery.result) {
        result = delivery.result;
        break;
      }
      if (delivery.cancelled) {
        cancelled = true;
        break;
      }
    }
    this.#finishDelivery(batch, { result, attempted, cancelled });
  }

  async #deliverAttempt(batch: readonly BufferedEvent[], attempt: number): Promise<DeliveryAttempt> {
    const credential = this.#deliveryCredential();
    if (!credential) return { attempted: false, cancelled: true };
    const controller = new AbortController();
    this.#activeExportController = controller;
    try {
      return { result: await this.#exportBatch(batch, credential, controller.signal), attempted: true, cancelled: false };
    } catch {
      return { attempted: true, cancelled: await this.#cancelledAfterFailure(attempt) };
    } finally {
      if (this.#activeExportController === controller) this.#activeExportController = null;
    }
  }

  async #cancelledAfterFailure(attempt: number): Promise<boolean> {
    if (this.#captureEnabled && this.#credential && attempt < this.#maxRetryAttempts) return !(await this.#waitRetry(this.#retryDelayMs * attempt));
    return !this.#captureEnabled || !this.#credential || this.#disposed;
  }

  async #exportBatch(batch: readonly BufferedEvent[], credential: EpisodeDiagnosticCredential, signal: AbortSignal): Promise<EpisodeDiagnosticDeliveryResult> {
    return (
      (await this.#exporter({
        endpoint: new URL(credential.intakePath, this.#apiBaseUrl).toString(),
        token: credential.token,
        signal,
        body: { version: 1, producer: { id: "sdk", instanceId: this.#instanceId, generation: credential.generation }, events: batch.map(({ event }) => event) },
      })) ?? { accepted: batch.map(({ event }) => event.eventId), duplicates: [], conflicts: [] }
    );
  }

  #finishDelivery(batch: readonly BufferedEvent[], delivery: DeliveryAttempt): void {
    if (this.#disposed || delivery.cancelled) return;
    if (delivery.result) {
      this.#quarantineBatch(batch, new Set(delivery.result.conflicts));
      this.#removeBatch(batch);
      return;
    }
    if (!delivery.attempted) return;
    this.#removeBatch(batch);
    this.#pendingGapCount += batch.length;
    this.#pendingGapReason = "delivery_retry_exhausted";
    this.#emitPendingGap();
  }

  async #export(request: Parameters<EpisodeDiagnosticExporter>[0]): Promise<EpisodeDiagnosticDeliveryResult> {
    if (!this.#fetch) throw new TypeError("Fetch is unavailable");
    const response = await this.#fetch(request.endpoint, {
      method: "POST",
      headers: { authorization: `Bearer ${request.token}`, "content-type": "application/json" },
      body: JSON.stringify(request.body),
      keepalive: true,
      signal: request.signal,
    });
    if (!response.ok) throw new TypeError(`Diagnostic intake rejected the batch with HTTP ${response.status}`);
    const result = await response.json();
    const delivery = parseIntakeResponse(result, new Set(request.body.events.map((event) => event.eventId)));
    if (!delivery) throw new TypeError("Diagnostic intake returned an invalid durable acknowledgement");
    return delivery;
  }

  #removeBatch(batch: readonly BufferedEvent[]): void {
    const ids = new Set(batch.map(({ event }) => event.eventId));
    for (let index = this.#queue.length - 1; index >= 0; index -= 1) {
      const queued = this.#queue[index];
      if (!queued || !ids.has(queued.event.eventId)) continue;
      this.#queue.splice(index, 1);
      this.#queueBytes -= queued.bytes;
    }
  }

  #quarantineBatch(batch: readonly BufferedEvent[], conflicts: ReadonlySet<string>): void {
    for (const event of batch) {
      if (!conflicts.has(event.event.eventId)) continue;
      this.#quarantine.push(event);
      this.#quarantineBytes += event.bytes;
    }
    while (this.#quarantine.length > this.#maxRingEvents || this.#quarantineBytes > this.#maxRingBytes) {
      const removed = this.#quarantine.shift();
      if (removed) this.#quarantineBytes -= removed.bytes;
    }
  }

  #enabled(): boolean {
    if (this.#disposed || !this.#captureEnabled || !this.#credential) return false;
    if (validCredential(this.#credential, this.#now())) return true;
    this.#disableCapture();
    return false;
  }

  #deliveryCredential(): EpisodeDiagnosticCredential | null {
    return this.#enabled() ? this.#credential : null;
  }

  #cancelTimer(): void {
    if (this.#timer !== undefined) this.#clearTimeout(this.#timer);
    this.#timer = undefined;
  }

  #disableCapture(): void {
    this.#credentialEpoch += 1;
    this.#credential = null;
    this.#captureEnabled = false;
    this.#cancelTimer();
    this.#activeExportController?.abort();
    this.#activeExportController = null;
    if (this.#retryTimer !== undefined) this.#clearTimeout(this.#retryTimer);
    this.#retryTimer = undefined;
    this.#retryResolve?.();
    this.#retryResolve = null;
  }

  #waitRetry(milliseconds: number): Promise<boolean> {
    if (this.#disposed || !this.#captureEnabled || !this.#credential) return Promise.resolve(false);
    return new Promise((resolve) => {
      let settled = false;
      const finish = (value: boolean) => {
        if (settled) return;
        settled = true;
        this.#retryTimer = undefined;
        this.#retryResolve = null;
        resolve(value);
      };
      this.#retryResolve = () => finish(false);
      this.#retryTimer = this.#setTimeout(() => finish(true), milliseconds);
    });
  }

  #clearBuffers(): void {
    this.#ring.length = 0;
    this.#queue.length = 0;
    this.#quarantine.length = 0;
    this.#ringBytes = 0;
    this.#queueBytes = 0;
    this.#quarantineBytes = 0;
    this.#pendingGapCount = 0;
    this.#pendingGapReason = "client_queue_overflow";
  }
}

function takeBatch(queue: readonly BufferedEvent[], maxEvents: number, maxBytes: number): readonly BufferedEvent[] {
  const batch: BufferedEvent[] = [];
  let bytes = 0;
  for (const event of queue) {
    if (batch.length >= maxEvents || (batch.length > 0 && bytes + event.bytes > maxBytes)) break;
    batch.push(event);
    bytes += event.bytes;
  }
  return batch;
}

function firstCheckpoint(name: string): string | undefined {
  return getActionContract(name)?.checkpoints[0]?.key;
}

function terminalCheckpoint(name: string): string | undefined {
  return TERMINAL_CHECKPOINT_OVERRIDES[name] ?? requiredTerminalCheckpoint(getActionContract(name)?.checkpoints);
}

function requiredTerminalCheckpoint(checkpoints: readonly { readonly key: string; readonly class: string }[] | undefined): string | undefined {
  if (!checkpoints) return undefined;
  for (let index = checkpoints.length - 1; index >= 0; index -= 1) {
    const checkpoint = checkpoints[index];
    if (checkpoint?.class === "required") return checkpoint.key;
  }
  return checkpoints[checkpoints.length - 1]?.key;
}

function reconnectBoundary(name: string): boolean {
  return name === "participant.reconnect" || name === "sync.reconnect" || name === "recovery.sync.retry" || name === "recovery.media.retry";
}

function compactCorrelation(correlation: DiagnosticEventCorrelation): DiagnosticEventCorrelation {
  return Object.fromEntries(Object.entries(correlation).filter(([, value]) => value !== undefined)) as DiagnosticEventCorrelation;
}

function correlationFromInput(input: EpisodeDiagnosticCorrelationInput | undefined): DiagnosticEventCorrelation {
  if (!input) return {};
  return compactCorrelation({
    journeyId: safeCorrelation(input.journeyId),
    traceId: safeCorrelation(input.traceId),
    spanId: safeCorrelation(input.spanId),
    requestId: safeCorrelation(input.requestId),
    commandId: safeCorrelation(input.commandId),
    retryGroupRef: safeCorrelation(input.retryGroupRef),
    attempt: typeof input.attempt === "number" && Number.isSafeInteger(input.attempt) && input.attempt >= 0 ? input.attempt : undefined,
    providerId: input.provider?.storage === "hmac" ? safeCorrelation(input.provider.value) : undefined,
  });
}

function validCredential(credential: EpisodeDiagnosticCredential, now: number): boolean {
  return validEpisodeDiagnosticCredential(credential, now);
}

function safeId(value: string): string {
  const bounded = value.replace(/[^A-Za-z0-9._:@+/=-]/gu, "_").slice(0, 128);
  return bounded.length > 0 && /^[A-Za-z0-9]/u.test(bounded) ? bounded : `sdk_${Date.now()}`;
}

function safeCorrelation(value: string | undefined): string | undefined {
  return value && /^[A-Za-z0-9][A-Za-z0-9._:@+/=-]{0,127}$/u.test(value) ? value : undefined;
}

function safeReason(value: string): string {
  return value.replace(/[^a-z0-9_.-]/giu, "_").slice(0, 64) || "unknown";
}

function safeRelease(value: DiagnosticRelease | undefined): DiagnosticRelease | undefined {
  const id = safeCorrelation(value?.id);
  const sourceCommit = safeCorrelation(value?.sourceCommit);
  return id ? Object.freeze({ id, ...(sourceCommit ? { sourceCommit } : {}) }) : undefined;
}

function positive(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function normalizedBaseUrl(value: string): string {
  const parsed = new URL(value);
  parsed.pathname = trimTrailingPathSlashes(parsed.pathname);
  parsed.search = "";
  parsed.hash = "";
  return stripTrailingUrlSlash(parsed.toString());
}

function parseIntakeResponse(value: unknown, expected: ReadonlySet<string>): EpisodeDiagnosticDeliveryResult | null {
  const response = intakeResponse(value);
  if (!response) return null;
  const accepted = intakeIds(response.accepted, expected, true);
  const duplicates = intakeIds(response.duplicates, expected, true);
  const conflicts = intakeIds(response.conflicts, expected, false);
  if (!accepted || !duplicates || !conflicts) return null;
  return completeDelivery({ accepted, duplicates, conflicts }, expected);
}

function buildDraftInput(input: EpisodeDiagnosticObservation, context: DraftContext): Record<string, unknown> {
  const contract = getActionContract(input.name);
  const checkpoint = input.checkpoint ?? contract?.checkpoints[0]?.key;
  const trace = parseTraceparent(context.traceparent);
  const correlation = compactCorrelation({ journeyId: context.journeyId, traceId: trace?.traceId, spanId: trace?.spanId, ...correlationFromInput(input.correlation) });
  return {
    version: 1,
    eventId: context.eventId,
    ...eventReferences(input),
    producerSequence: context.producerSequence,
    occurredAt: context.occurredAt,
    source: "sdk",
    name: input.name,
    phase: input.phase,
    state: input.state,
    expectation: expectationFor(contract, checkpoint),
    correlation: optionalCorrelation(correlation),
    release: context.release,
    attributes: redactDiagnosticAttributes(input.attributes).attributes,
  };
}

function eventReferences(input: EpisodeDiagnosticObservation): Readonly<Record<string, string | undefined>> {
  return { producerOperationRef: optionalSafeId(input.operationRef), parentProducerOperationRef: optionalSafeId(input.parentOperationRef) };
}

function optionalSafeId(value: string | undefined): string | undefined {
  return value === undefined ? undefined : safeId(value);
}

function expectationFor(contract: ReturnType<typeof getActionContract>, checkpoint: string | undefined): Readonly<Record<string, unknown>> | undefined {
  const checkpointContract = contract?.checkpoints.find((candidate) => candidate.key === checkpoint);
  return contract && checkpoint && checkpointContract ? { name: contract.operation, version: contract.expectationVersion, checkpoint, checkpointClass: checkpointContract.class } : undefined;
}

function optionalCorrelation(correlation: DiagnosticEventCorrelation): DiagnosticEventCorrelation | undefined {
  return Object.keys(correlation).length > 0 ? correlation : undefined;
}

function trimTrailingPathSlashes(value: string): string {
  return value.replace(/\/+$/u, "");
}

function stripTrailingUrlSlash(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

function intakeResponse(value: unknown): IntakeResponse | null {
  if (!isRecord(value) || typeof value.diagnosticReference !== "string" || !Number.isSafeInteger(value.committedCursor)) return null;
  if (!Array.isArray(value.accepted) || !Array.isArray(value.duplicates) || !Array.isArray(value.conflicts)) return null;
  return { accepted: value.accepted, duplicates: value.duplicates, conflicts: value.conflicts };
}

function completeDelivery(delivery: Readonly<{ accepted: readonly string[]; duplicates: readonly string[]; conflicts: readonly string[] }>, expected: ReadonlySet<string>): EpisodeDiagnosticDeliveryResult | null {
  const all = [...delivery.accepted, ...delivery.duplicates, ...delivery.conflicts];
  return all.length === expected.size && new Set(all).size === expected.size ? Object.freeze(delivery) : null;
}

function intakeIds(items: readonly unknown[], expected: ReadonlySet<string>, cursorRequired: boolean): readonly string[] | null {
  const ids: string[] = [];
  for (const item of items) {
    if (!isRecord(item) || typeof item.eventId !== "string" || !expected.has(item.eventId)) return null;
    if (cursorRequired && !Number.isSafeInteger(item.cursor)) return null;
    if (!cursorRequired && item.code !== "fingerprint_mismatch") return null;
    ids.push(item.eventId);
  }
  return ids;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export { parseEpisodeDiagnosticCredential };
export type { DiagnosticAttributes, EpisodeDiagnosticCredential };
