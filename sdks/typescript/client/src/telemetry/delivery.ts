import { Context, Data, Deferred, Effect, Layer, ManagedRuntime, Queue, Schedule, Semaphore, Stream, SubscriptionRef, type Scope } from "effect";
import { encodedByteLength, isRetriableTelemetryExportError, journeyContextBatches, journeyIntakeBody, MAX_JOURNEY_INTAKE_EVENTS_PER_BATCH, MAX_KEEPALIVE_BODY_BYTES, sharesJourneyContext, toJourneyIntakeEvent, type TelemetryExporter, type TelemetryExportOptions } from "./exporter";
import type { TelemetryStorage } from "./storage";
import type { JourneyPhase, JourneyState, TelemetryEvent } from "./types";

export type TelemetryExporterHealth = {
  readonly droppedEvents: number;
  readonly exportedEvents: number;
  readonly failedBatches: number;
  readonly lastError?: string;
  readonly queueDepth: number;
  readonly status: "degraded" | "idle" | "healthy";
};

export type TelemetryTimelineEntry = {
  readonly eventId: string;
  readonly name: TelemetryEvent["name"];
  readonly occurredAt: string;
  readonly phase: JourneyPhase;
  readonly state: JourneyState;
};

export type TelemetryDeliveryOptions = {
  readonly batchSize: number;
  readonly enabled: boolean;
  readonly exporter?: TelemetryExporter;
  readonly maxQueueSize: number;
  readonly maxTimelineEntries: number;
  readonly onDrop?: (droppedEvents: readonly TelemetryEvent[]) => void;
  readonly retryDelayMs: number;
  readonly storage?: TelemetryStorage;
};

type BatchDeliveryResult = "delivered" | "discarded" | "retry";

export const NORMAL_FLUSH_DELAY_MS = 50;

export class TelemetryExportFailure extends Data.TaggedError("TelemetryExportFailure")<{
  readonly cause: unknown;
  readonly retriable: boolean;
}> {}

export class TelemetryStorageFailure extends Data.TaggedError("TelemetryStorageFailure")<{
  readonly cause: unknown;
}> {}

export type TelemetryExporterCapability = {
  readonly configured: boolean;
  readonly export: (events: readonly ReturnType<typeof toJourneyIntakeEvent>[], options?: TelemetryExportOptions) => Effect.Effect<void, TelemetryExportFailure>;
};

export type TelemetryStorageCapability = {
  readonly configured: boolean;
  readonly load: Effect.Effect<readonly TelemetryEvent[], TelemetryStorageFailure>;
  readonly save: (events: readonly TelemetryEvent[]) => Effect.Effect<void, TelemetryStorageFailure>;
};

/** Capability boundary for the existing Promise-based exporter. */
export class TelemetryExporterService extends Context.Service<TelemetryExporterService, TelemetryExporterCapability>()("@chalk/telemetry/TelemetryExporter") {}

/** Capability boundary for the existing Promise-based durable queue. */
export class TelemetryStorageService extends Context.Service<TelemetryStorageService, TelemetryStorageCapability>()("@chalk/telemetry/TelemetryStorage") {}

export const makeTelemetryExporterLayer = (exporter?: TelemetryExporter) => Layer.succeed(TelemetryExporterService, telemetryExporterCapability(exporter));

export const makeFakeTelemetryExporterLayer = (exporter: TelemetryExporter) => makeTelemetryExporterLayer(exporter);

export const makeTelemetryStorageLayer = (storage?: TelemetryStorage) => Layer.succeed(TelemetryStorageService, telemetryStorageCapability(storage));

export const makeFakeTelemetryStorageLayer = (storage: TelemetryStorage) => makeTelemetryStorageLayer(storage);

export type TelemetryDeliveryEffectService = {
  readonly healthRef: SubscriptionRef.SubscriptionRef<TelemetryExporterHealth>;
  readonly pendingRef: SubscriptionRef.SubscriptionRef<readonly TelemetryEvent[]>;
  readonly enqueue: (event: TelemetryEvent) => Effect.Effect<void>;
  readonly enqueueUnsafe: (event: TelemetryEvent) => boolean;
  readonly flush: (options?: TelemetryExportOptions) => Effect.Effect<void>;
  readonly persist: () => Effect.Effect<void>;
  readonly dispose: () => Effect.Effect<void>;
  readonly awaitReady: () => Effect.Effect<void>;
  readonly getHealthUnsafe: () => TelemetryExporterHealth;
  readonly getPendingEventsUnsafe: () => readonly TelemetryEvent[];
  readonly getTimelineUnsafe: () => readonly TelemetryTimelineEntry[];
  readonly subscribe: (listener: (health: TelemetryExporterHealth) => void) => () => void;
};

/** The scoped, Effect-native delivery capability. */
export class TelemetryDeliveryService extends Context.Service<TelemetryDeliveryService, TelemetryDeliveryEffectService>()("@chalk/telemetry/TelemetryDelivery") {}

/** Builds a scoped delivery capability using production wrappers around the legacy interfaces. */
export const makeTelemetryDeliveryLayer = (options: TelemetryDeliveryOptions) => Layer.effect(TelemetryDeliveryService, makeTelemetryDeliveryService(options));

/** Builds a scoped delivery capability from exporter and storage services supplied by a test or application layer. */
export const makeTelemetryDeliveryLayerFromServices = (options: Omit<TelemetryDeliveryOptions, "exporter" | "storage">) =>
  Layer.effect(
    TelemetryDeliveryService,
    Effect.gen(function* () {
      const exporter = yield* Effect.service(TelemetryExporterService);
      const storage = yield* Effect.service(TelemetryStorageService);
      return yield* makeTelemetryDeliveryService(options, exporter, storage);
    }),
  );

export function makeTelemetryDeliveryService(options: TelemetryDeliveryOptions, exporter = telemetryExporterCapability(options.exporter), storage = telemetryStorageCapability(options.storage)): Effect.Effect<TelemetryDeliveryEffectService, never, Scope.Scope> {
  return Effect.gen(function* () {
    const scope = yield* Effect.scope;
    const delivery = createTelemetryDeliveryService(options, exporter, storage, scope);
    yield* delivery.startScoped();
    if (!options.enabled || !storage.configured) yield* delivery.restore();
    else yield* delivery.restore().pipe(Effect.forkScoped({ startImmediately: true }));
    yield* Effect.addFinalizer(() => delivery.dispose());
    return delivery;
  });
}

/**
 * Compatibility facade for the synchronous client API. All durable work stays
 * in the scoped Effect pipeline below; this class only bridges its public
 * Promise methods and immediate snapshots.
 */
export class TelemetryDelivery {
  readonly #disposedPromise: Promise<void>;
  readonly #markDisposed: () => void;
  readonly #service: TelemetryDeliveryEffectService;
  readonly #runtime: ManagedRuntime.ManagedRuntime<TelemetryDeliveryService, never>;
  readonly #loading: Promise<void>;
  #disposePromise: Promise<void> | undefined;

  constructor(options: TelemetryDeliveryOptions) {
    let markDisposed: (() => void) | undefined;
    this.#disposedPromise = new Promise<void>((resolve) => {
      markDisposed = resolve;
    });
    this.#markDisposed = () => markDisposed?.();
    this.#runtime = ManagedRuntime.make(makeTelemetryDeliveryLayer(options));
    this.#service = this.#runtime.runSync(Effect.service(TelemetryDeliveryService));
    this.#loading = this.#runtime.runPromise(this.#service.awaitReady());
  }

  getHealth(): TelemetryExporterHealth {
    return this.#service.getHealthUnsafe();
  }

  getTimeline(): readonly TelemetryTimelineEntry[] {
    return this.#service.getTimelineUnsafe();
  }

  getPendingEvents(): readonly TelemetryEvent[] {
    return this.#service.getPendingEventsUnsafe();
  }

  subscribe(listener: (health: TelemetryExporterHealth) => void): () => void {
    return this.#service.subscribe(listener);
  }

  async flush(options?: TelemetryExportOptions): Promise<void> {
    await this.#loading;
    await Promise.race([this.#runtime.runPromise(this.#service.flush(options)), this.#disposedPromise]);
  }

  dispose(): void {
    if (this.#disposePromise) return;
    this.#markDisposed();
    Effect.runSync(this.#service.dispose());
    this.#disposePromise = this.#runtime.dispose();
  }

  enqueue(event: TelemetryEvent): void {
    const flushNow = this.#service.enqueueUnsafe(event);
    void this.#runtime.runPromiseExit(flushNow ? this.#service.flush() : this.#service.persist());
  }
}

class DeliveryService implements TelemetryDeliveryEffectService {
  readonly #activeKeepaliveBatchEventIds = new Set<string>();
  readonly #activeNormalBatchEventIds = new Set<string>();
  readonly #batchSize: number;
  readonly #healthListeners = new Set<(health: TelemetryExporterHealth) => void>();
  readonly #knownEventIds = new Set<string>();
  readonly #normalGate = Semaphore.makeUnsafe(1);
  readonly #persistenceGate = Semaphore.makeUnsafe(1);
  readonly #queue: Queue.Queue<TelemetryEvent>;
  readonly #ready = Deferred.makeUnsafe<void>();
  readonly #recentEventIds: string[] = [];
  readonly #timeline: TelemetryTimelineEntry[] = [];
  #disposed = false;
  #loaded = false;
  #restoreStarted = false;
  #retryScheduled = false;

  constructor(
    readonly options: TelemetryDeliveryOptions,
    readonly exporter: TelemetryExporterCapability,
    readonly storage: TelemetryStorageCapability,
    readonly healthRef: SubscriptionRef.SubscriptionRef<TelemetryExporterHealth>,
    readonly pendingRef: SubscriptionRef.SubscriptionRef<readonly TelemetryEvent[]>,
    queue: Queue.Queue<TelemetryEvent>,
    readonly scope: Scope.Scope,
  ) {
    this.#batchSize = Math.min(options.batchSize, MAX_JOURNEY_INTAKE_EVENTS_PER_BATCH);
    this.#queue = queue;
  }

  startScoped(): Effect.Effect<void, never, Scope.Scope> {
    return Stream.fromQueue(this.#queue).pipe(
      Stream.groupedWithin(this.#batchSize, NORMAL_FLUSH_DELAY_MS),
      Stream.runForEach(() => this.flush()),
      Effect.catch(() => Effect.void),
      Effect.forkScoped,
      Effect.asVoid,
    );
  }

  restore(): Effect.Effect<void> {
    return Effect.suspend(() => {
      if (this.#restoreStarted) return Deferred.await(this.#ready);
      this.#restoreStarted = true;
      if (!this.options.enabled || !this.storage.configured) {
        return Effect.sync(() => {
          this.#loaded = true;
        }).pipe(Effect.andThen(Deferred.succeed(this.#ready, undefined)), Effect.asVoid);
      }

      return this.storage.load.pipe(
        Effect.catch((error) => this.storageFailed(error).pipe(Effect.as([] as readonly TelemetryEvent[]))),
        Effect.tap((persisted) =>
          Effect.sync(() => {
            this.mergeRestored(persisted);
            this.#loaded = true;
            Queue.offerAllUnsafe(this.#queue, this.getPendingEventsUnsafe());
          }),
        ),
        Effect.andThen(this.persist()),
        Effect.ensuring(Deferred.succeed(this.#ready, undefined)),
        Effect.asVoid,
      );
    });
  }

  awaitReady(): Effect.Effect<void> {
    return Deferred.await(this.#ready);
  }

  dispose(): Effect.Effect<void> {
    return Effect.suspend(() => {
      if (this.#disposed) return Effect.void;
      this.#disposed = true;
      this.#retryScheduled = false;
      return Queue.shutdown(this.#queue);
    });
  }

  persist(): Effect.Effect<void> {
    return Effect.suspend(() => {
      if (!this.#loaded || !this.options.enabled || !this.storage.configured) return Effect.void;
      return this.#persistenceGate.withPermit(Effect.suspend(() => this.storage.save(this.getPendingEventsUnsafe())).pipe(Effect.catch((error) => this.storageFailed(error))));
    });
  }

  enqueue(event: TelemetryEvent): Effect.Effect<void> {
    return Effect.sync(() => this.enqueueUnsafe(event)).pipe(Effect.andThen(this.persist()));
  }

  enqueueUnsafe(event: TelemetryEvent): boolean {
    if (this.#disposed || !this.options.enabled || this.#knownEventIds.has(event.event_id)) return false;
    this.trackEventID(event.event_id);
    const pending = [...this.getPendingEventsUnsafe(), event];
    this.setPendingUnsafe(pending);
    this.#timeline.push({ eventId: event.event_id, name: event.name, occurredAt: event.occurred_at, phase: event.phase, state: event.state });
    if (this.#timeline.length > this.options.maxTimelineEntries) this.#timeline.splice(0, this.#timeline.length - this.options.maxTimelineEntries);
    this.handleQueueOverflowUnsafe();
    this.setHealthUnsafe({ queueDepth: this.getPendingEventsUnsafe().length });
    Queue.offerUnsafe(this.#queue, event);
    return this.#loaded && this.nextBatch().length === this.#batchSize;
  }

  flush(options?: TelemetryExportOptions): Effect.Effect<void> {
    if (options?.keepalive) return this.flushKeepalive();
    return this.#normalGate.withPermit(this.flushNormal());
  }

  getHealthUnsafe(): TelemetryExporterHealth {
    return { ...SubscriptionRef.getUnsafe(this.healthRef) };
  }

  getPendingEventsUnsafe(): readonly TelemetryEvent[] {
    return [...SubscriptionRef.getUnsafe(this.pendingRef)];
  }

  getTimelineUnsafe(): readonly TelemetryTimelineEntry[] {
    return [...this.#timeline];
  }

  subscribe(listener: (health: TelemetryExporterHealth) => void): () => void {
    this.#healthListeners.add(listener);
    listener(this.getHealthUnsafe());
    return () => this.#healthListeners.delete(listener);
  }

  private flushNormal(): Effect.Effect<void> {
    return Effect.suspend(() => {
      if (!this.canFlushNormal()) return Effect.void;
      const batch = this.nextBatch();
      if (batch.length === 0) return Effect.void;
      this.activateNormalBatch(batch);
      return this.deliverNormalBatch(batch).pipe(
        Effect.flatMap((result) => {
          if (result === "retry") return Effect.void;
          const removed = this.removeExportedNormalBatch(batch);
          this.recordBatchResultUnsafe(result, removed);
          return this.persist().pipe(Effect.andThen(this.flushNormal()));
        }),
      );
    });
  }

  private deliverNormalBatch(batch: readonly TelemetryEvent[]): Effect.Effect<BatchDeliveryResult> {
    return this.exporter.export(batch.map(toJourneyIntakeEvent)).pipe(
      Effect.as<BatchDeliveryResult>("delivered"),
      Effect.catch((error) => {
        this.exportFailedUnsafe(error);
        if (!error.retriable) return Effect.succeed<BatchDeliveryResult>("discarded");
        return Effect.sync(() => this.deactivateNormalBatch(batch)).pipe(Effect.andThen(this.persist()), Effect.andThen(this.scheduleRetry()), Effect.as<BatchDeliveryResult>("retry"));
      }),
    );
  }

  private flushKeepalive(): Effect.Effect<void> {
    return Effect.suspend(() => {
      if (!this.canFlushKeepalive()) return Effect.void;
      const batch = this.keepaliveBatch();
      if (batch.length === 0) return Effect.void;
      this.activateKeepaliveBatch(batch);
      return this.exporter.export(batch.map(toJourneyIntakeEvent), { keepalive: true }).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            const removed = this.removePendingEvents(batch);
            if (removed.length > 0) this.recordExportSuccessUnsafe(removed.length);
          }).pipe(Effect.andThen(this.persist())),
        ),
        Effect.catch((error) => Effect.sync(() => this.exportFailedUnsafe(error))),
        Effect.ensuring(Effect.sync(() => this.deactivateKeepaliveBatch(batch))),
        Effect.asVoid,
      );
    });
  }

  private canFlushNormal(): boolean {
    return !this.#disposed && this.#loaded && this.options.enabled && this.exporter.configured && !this.#retryScheduled && this.getPendingEventsUnsafe().length > 0;
  }

  private canFlushKeepalive(): boolean {
    return !this.#disposed && this.#loaded && this.options.enabled && this.exporter.configured && this.getPendingEventsUnsafe().length > 0;
  }

  private nextBatch(): TelemetryEvent[] {
    const available = this.getPendingEventsUnsafe().filter((event) => !this.isBatchActive(event));
    return journeyContextBatches(available)[0]?.slice(0, this.#batchSize) ?? [];
  }

  private keepaliveBatch(): TelemetryEvent[] {
    const available = this.getPendingEventsUnsafe().filter((event) => !this.#activeKeepaliveBatchEventIds.has(event.event_id));
    const [newestEvent] = available.slice(-this.#batchSize).reverse();
    if (!newestEvent) return [];
    return boundedKeepaliveBatch(
      available
        .slice(-this.#batchSize)
        .reverse()
        .filter((event) => sharesJourneyContext(event, newestEvent)),
    );
  }

  private activateNormalBatch(batch: readonly TelemetryEvent[]): void {
    for (const event of batch) this.#activeNormalBatchEventIds.add(event.event_id);
  }

  private activateKeepaliveBatch(batch: readonly TelemetryEvent[]): void {
    for (const event of batch) this.#activeKeepaliveBatchEventIds.add(event.event_id);
  }

  private removeExportedNormalBatch(batch: readonly TelemetryEvent[]): TelemetryEvent[] {
    const removed = this.removePendingEvents(batch);
    this.deactivateNormalBatch(batch);
    return removed;
  }

  private deactivateNormalBatch(batch: readonly TelemetryEvent[]): void {
    for (const event of batch) this.#activeNormalBatchEventIds.delete(event.event_id);
  }

  private deactivateKeepaliveBatch(batch: readonly TelemetryEvent[]): void {
    for (const event of batch) this.#activeKeepaliveBatchEventIds.delete(event.event_id);
  }

  private isBatchActive(event: TelemetryEvent): boolean {
    return this.#activeNormalBatchEventIds.has(event.event_id) || this.#activeKeepaliveBatchEventIds.has(event.event_id);
  }

  private removePendingEvents(events: readonly TelemetryEvent[]): TelemetryEvent[] {
    const eventIds = new Set(events.map((event) => event.event_id));
    const pending = this.getPendingEventsUnsafe();
    const removed = pending.filter((event) => eventIds.has(event.event_id));
    this.setPendingUnsafe(pending.filter((event) => !eventIds.has(event.event_id)));
    return removed;
  }

  private trackEventID(eventId: string): void {
    this.#knownEventIds.add(eventId);
    this.#recentEventIds.push(eventId);
    if (this.#recentEventIds.length <= this.options.maxQueueSize * 4) return;
    const expired = this.#recentEventIds.splice(0, this.#recentEventIds.length - this.options.maxQueueSize * 4);
    for (const expiredEventId of expired) this.#knownEventIds.delete(expiredEventId);
  }

  private handleQueueOverflowUnsafe(): void {
    const pending = this.getPendingEventsUnsafe();
    const overflow = Math.max(0, pending.length - this.options.maxQueueSize);
    const dropped = pending.filter((event) => !this.isBatchActive(event)).slice(0, overflow);
    if (dropped.length === 0) return;
    const droppedEventIds = new Set(dropped.map((event) => event.event_id));
    this.setPendingUnsafe(pending.filter((event) => !droppedEventIds.has(event.event_id)));
    this.setHealthUnsafe({ droppedEvents: this.getHealthUnsafe().droppedEvents + dropped.length, queueDepth: this.getPendingEventsUnsafe().length });
    queueMicrotask(() => this.notifyDrops(dropped));
  }

  private mergeRestored(persisted: readonly TelemetryEvent[]): void {
    const restored = persisted.filter((event) => !this.#knownEventIds.has(event.event_id));
    for (const event of restored) this.trackEventID(event.event_id);
    this.setPendingUnsafe([...restored, ...this.getPendingEventsUnsafe()]);
    this.handleQueueOverflowUnsafe();
    this.setHealthUnsafe({ queueDepth: this.getPendingEventsUnsafe().length });
  }

  private recordBatchResultUnsafe(result: Exclude<BatchDeliveryResult, "retry">, batch: readonly TelemetryEvent[]): void {
    if (batch.length === 0) return;
    if (result === "delivered") {
      this.recordExportSuccessUnsafe(batch.length);
      return;
    }
    this.setHealthUnsafe({ droppedEvents: this.getHealthUnsafe().droppedEvents + batch.length, queueDepth: this.getPendingEventsUnsafe().length });
    queueMicrotask(() => this.notifyDrops(batch));
  }

  private recordExportSuccessUnsafe(batchSize: number): void {
    this.setHealthUnsafe({
      exportedEvents: this.getHealthUnsafe().exportedEvents + batchSize,
      lastError: undefined,
      queueDepth: this.getPendingEventsUnsafe().length,
      status: "healthy",
    });
  }

  private exportFailedUnsafe(error: TelemetryExportFailure): void {
    this.setHealthUnsafe({
      failedBatches: this.getHealthUnsafe().failedBatches + 1,
      lastError: errorMessage(error.cause),
      queueDepth: this.getPendingEventsUnsafe().length,
      status: "degraded",
    });
  }

  private storageFailed(error: TelemetryStorageFailure): Effect.Effect<void> {
    return Effect.sync(() => this.setHealthUnsafe({ lastError: errorMessage(error.cause), status: "degraded" }));
  }

  private scheduleRetry(): Effect.Effect<void> {
    return Effect.suspend(() => {
      if (this.#disposed || this.#retryScheduled) return Effect.void;
      this.#retryScheduled = true;
      return Effect.forkIn(
        Effect.void.pipe(
          Effect.repeat(Schedule.spaced(this.options.retryDelayMs).pipe(Schedule.take(1))),
          Effect.andThen(
            Effect.sync(() => {
              this.#retryScheduled = false;
            }),
          ),
          Effect.andThen(this.flush()),
          Effect.catch(() => Effect.void),
        ),
        this.scope,
      ).pipe(Effect.asVoid);
    });
  }

  private setPendingUnsafe(events: readonly TelemetryEvent[]): void {
    Effect.runSync(SubscriptionRef.set(this.pendingRef, [...events]));
  }

  private setHealthUnsafe(update: Partial<TelemetryExporterHealth>): void {
    const health = { ...this.getHealthUnsafe(), ...update };
    Effect.runSync(SubscriptionRef.set(this.healthRef, health));
    for (const listener of this.#healthListeners) {
      try {
        listener({ ...health });
      } catch {
        // Exporter health listeners are diagnostic-only.
      }
    }
  }

  private notifyDrops(dropped: readonly TelemetryEvent[]): void {
    try {
      this.options.onDrop?.(dropped);
    } catch {
      // A consumer signal must not interrupt the meeting path.
    }
  }
}

function createTelemetryDeliveryService(options: TelemetryDeliveryOptions, exporter: TelemetryExporterCapability, storage: TelemetryStorageCapability, scope: Scope.Scope): DeliveryService {
  return new DeliveryService(
    options,
    exporter,
    storage,
    Effect.runSync(
      SubscriptionRef.make<TelemetryExporterHealth>({
        droppedEvents: 0,
        exportedEvents: 0,
        failedBatches: 0,
        queueDepth: 0,
        status: "idle",
      }),
    ),
    Effect.runSync(SubscriptionRef.make<readonly TelemetryEvent[]>([])),
    Effect.runSync(Queue.make<TelemetryEvent>()),
    scope,
  );
}

function telemetryExporterCapability(exporter?: TelemetryExporter): TelemetryExporterCapability {
  return {
    configured: exporter !== undefined,
    export: (events, options) => {
      if (!exporter) return Effect.void;
      return Effect.tryPromise({
        try: () => exporter(events, options),
        catch: (cause) => new TelemetryExportFailure({ cause, retriable: isRetriableTelemetryExportError(cause) }),
      }).pipe(Effect.asVoid);
    },
  };
}

function telemetryStorageCapability(storage?: TelemetryStorage): TelemetryStorageCapability {
  return {
    configured: storage !== undefined,
    load: storage ? Effect.tryPromise({ try: () => storage.load(), catch: (cause) => new TelemetryStorageFailure({ cause }) }) : Effect.succeed([]),
    save: (events) => (storage ? Effect.tryPromise({ try: () => storage.save(events), catch: (cause) => new TelemetryStorageFailure({ cause }) }) : Effect.void),
  };
}

function boundedKeepaliveBatch(events: readonly TelemetryEvent[]): TelemetryEvent[] {
  const batch: TelemetryEvent[] = [];
  for (const event of events) {
    if (!keepaliveEventFits(event, batch)) break;
    batch.unshift(event);
  }
  return batch;
}

function keepaliveEventFits(event: TelemetryEvent, batch: readonly TelemetryEvent[]): boolean {
  return encodedByteLength(journeyIntakeBody([event, ...batch].map(toJourneyIntakeEvent))) <= MAX_KEEPALIVE_BODY_BYTES;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Telemetry exporter failed";
}
