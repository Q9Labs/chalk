import { encodedByteLength, isRetriableTelemetryExportError, journeyContextBatches, journeyIntakeBody, MAX_JOURNEY_INTAKE_EVENTS_PER_BATCH, MAX_KEEPALIVE_BODY_BYTES, sharesJourneyContext, toJourneyIntakeEvent, type TelemetryExporter, type TelemetryExportOptions } from "./exporter";
import type { TelemetryStorage } from "./storage";
import type { JourneyPhase, JourneyState, TelemetryEvent } from "./types";

export interface TelemetryExporterHealth {
  readonly droppedEvents: number;
  readonly exportedEvents: number;
  readonly failedBatches: number;
  readonly lastError?: string;
  readonly queueDepth: number;
  readonly status: "degraded" | "idle" | "healthy";
}

export interface TelemetryTimelineEntry {
  readonly eventId: string;
  readonly name: TelemetryEvent["name"];
  readonly occurredAt: string;
  readonly phase: JourneyPhase;
  readonly state: JourneyState;
}

export interface TelemetryDeliveryOptions {
  readonly batchSize: number;
  readonly enabled: boolean;
  readonly exporter?: TelemetryExporter;
  readonly maxQueueSize: number;
  readonly maxTimelineEntries: number;
  readonly onDrop?: (droppedEvents: readonly TelemetryEvent[]) => void;
  readonly retryDelayMs: number;
  readonly storage?: TelemetryStorage;
}

type BatchDeliveryResult = "delivered" | "discarded" | "retry";

export const NORMAL_FLUSH_DELAY_MS = 50;

export class TelemetryDelivery {
  private readonly activeKeepaliveBatchEventIds = new Set<string>();
  private readonly activeNormalBatchEventIds = new Set<string>();
  private readonly activeKeepaliveFlushes = new Set<Promise<void>>();
  private readonly knownEventIds = new Set<string>();
  private readonly healthListeners = new Set<(health: TelemetryExporterHealth) => void>();
  private readonly recentEventIds: string[] = [];
  private readonly timeline: TelemetryTimelineEntry[] = [];
  private readonly batchSize: number;
  private batchTimer: ReturnType<typeof setTimeout> | undefined;
  private flushInFlight: Promise<void> | undefined;
  private health: TelemetryExporterHealth = {
    droppedEvents: 0,
    exportedEvents: 0,
    failedBatches: 0,
    queueDepth: 0,
    status: "idle",
  };
  private readonly loading: Promise<void>;
  private disposed = false;
  private pending: TelemetryEvent[] = [];
  private persistence: Promise<void> = Promise.resolve();
  private retryTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly options: TelemetryDeliveryOptions) {
    this.batchSize = Math.min(options.batchSize, MAX_JOURNEY_INTAKE_EVENTS_PER_BATCH);
    this.loading = this.restore();
  }

  getHealth(): TelemetryExporterHealth {
    return { ...this.health };
  }

  getTimeline(): readonly TelemetryTimelineEntry[] {
    return [...this.timeline];
  }

  getPendingEvents(): readonly TelemetryEvent[] {
    return [...this.pending];
  }

  subscribe(listener: (health: TelemetryExporterHealth) => void): () => void {
    this.healthListeners.add(listener);
    listener(this.getHealth());
    return () => this.healthListeners.delete(listener);
  }

  async flush(options?: TelemetryExportOptions): Promise<void> {
    await this.loading;
    if (options?.keepalive) return this.flushKeepalive();
    this.cancelBatchTimer();
    return this.flushNormal(options);
  }

  private flushNormal(options?: TelemetryExportOptions): Promise<void> {
    if (!this.canFlush()) return Promise.resolve();
    return this.activeFlush(options);
  }

  dispose(): void {
    this.disposed = true;
    this.cancelBatchTimer();
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = undefined;
    }
  }

  enqueue(event: TelemetryEvent): void {
    if (this.disposed || !this.options.enabled || this.knownEventIds.has(event.event_id)) return;
    this.trackEventID(event.event_id);
    this.appendEvent(event);
    this.handleQueueOverflow();
    this.setHealth({ queueDepth: this.pending.length });
    void this.persist();
    this.scheduleBatchFlush();
  }

  private activeFlush(options?: TelemetryExportOptions): Promise<void> {
    if (this.flushInFlight) return this.flushInFlight;
    this.flushInFlight = this.exportPending(options).finally(() => {
      this.flushInFlight = undefined;
    });
    return this.flushInFlight;
  }

  private flushKeepalive(): Promise<void> {
    if (!this.canFlush({ keepalive: true })) return Promise.resolve();
    return this.flushPendingKeepalive(this.flushInFlight ?? Promise.resolve());
  }

  private flushPendingKeepalive(inFlight: Promise<void>): Promise<void> {
    const batch = this.keepaliveBatch();
    if (batch.length === 0) return Promise.all([inFlight, ...this.activeKeepaliveFlushes]).then(() => undefined);
    this.activateKeepaliveBatch(batch);
    const flush = this.exportKeepaliveBatch(batch);
    this.activeKeepaliveFlushes.add(flush);
    return flush.finally(() => {
      this.activeKeepaliveFlushes.delete(flush);
    });
  }

  private keepaliveBatch(): TelemetryEvent[] {
    const available = this.pending.filter((event) => !this.activeKeepaliveBatchEventIds.has(event.event_id));
    const [newestEvent] = available.slice(-this.batchSize).reverse();
    if (!newestEvent) return [];
    const compatible = available
      .slice(-this.batchSize)
      .reverse()
      .filter((event) => sharesJourneyContext(event, newestEvent));
    return boundedKeepaliveBatch(compatible);
  }

  private canFlush(options?: TelemetryExportOptions): boolean {
    return this.canExport() && this.retryAllowsFlush(options);
  }

  private canExport(): boolean {
    return this.isEnabled() && this.hasPendingEvents();
  }

  private isEnabled(): boolean {
    return !this.disposed && this.options.enabled && this.options.exporter !== undefined;
  }

  private hasPendingEvents(): boolean {
    return this.pending.length > 0;
  }

  private retryAllowsFlush(options: TelemetryExportOptions | undefined): boolean {
    return options?.keepalive === true || this.retryTimer === undefined;
  }

  private trackEventID(eventId: string): void {
    this.knownEventIds.add(eventId);
    this.recentEventIds.push(eventId);
    if (this.recentEventIds.length <= this.options.maxQueueSize * 4) return;
    const expiredIds = this.recentEventIds.splice(0, this.recentEventIds.length - this.options.maxQueueSize * 4);
    for (const expiredEventId of expiredIds) this.knownEventIds.delete(expiredEventId);
  }

  private appendEvent(event: TelemetryEvent): void {
    this.pending.push(event);
    this.timeline.push({ eventId: event.event_id, name: event.name, occurredAt: event.occurred_at, phase: event.phase, state: event.state });
    if (this.timeline.length > this.options.maxTimelineEntries) {
      this.timeline.splice(0, this.timeline.length - this.options.maxTimelineEntries);
    }
  }

  private handleQueueOverflow(): void {
    const dropped = this.removeOverflowEvents();
    if (dropped.length === 0) return;
    this.setHealth({ droppedEvents: this.health.droppedEvents + dropped.length });
    queueMicrotask(() => this.notifyDrops(dropped));
  }

  private removeOverflowEvents(): TelemetryEvent[] {
    const overflow = Math.max(0, this.pending.length - this.options.maxQueueSize);
    const dropped = this.pending.filter((event) => !this.isBatchActive(event)).slice(0, overflow);
    const droppedEventIds = new Set(dropped.map((event) => event.event_id));
    this.pending = this.pending.filter((event) => !droppedEventIds.has(event.event_id));
    return dropped;
  }

  private notifyDrops(dropped: readonly TelemetryEvent[]): void {
    try {
      this.options.onDrop?.(dropped);
    } catch {
      // A consumer signal must not interrupt the meeting path.
    }
  }

  private async exportPending(options?: TelemetryExportOptions): Promise<void> {
    while (this.canFlush(options)) {
      if (!(await this.exportNextBatch(options))) return;
    }
  }

  private async exportNextBatch(options?: TelemetryExportOptions): Promise<boolean> {
    const batch = this.nextBatch();
    if (batch.length === 0) return false;
    this.activateNormalBatch(batch);
    const result = await this.deliverBatch(batch, options);
    if (result === "retry") return false;
    const removed = this.removeExportedBatch(batch);
    this.recordBatchResult(result, removed);
    await this.persist();
    return true;
  }

  private nextBatch(): TelemetryEvent[] {
    const available = this.pending.filter((event) => !this.isBatchActive(event));
    return journeyContextBatches(available)[0]?.slice(0, this.batchSize) ?? [];
  }

  private activateNormalBatch(batch: readonly TelemetryEvent[]): void {
    for (const event of batch) this.activeNormalBatchEventIds.add(event.event_id);
  }

  private activateKeepaliveBatch(batch: readonly TelemetryEvent[]): void {
    for (const event of batch) this.activeKeepaliveBatchEventIds.add(event.event_id);
  }

  private async deliverBatch(batch: readonly TelemetryEvent[], options?: TelemetryExportOptions): Promise<BatchDeliveryResult> {
    try {
      await this.options.exporter?.(batch.map(toJourneyIntakeEvent), options);
      return "delivered";
    } catch (error) {
      this.exportFailed(error);
      if (!isRetriableTelemetryExportError(error)) return "discarded";
      this.deactivateNormalBatch(batch);
      await this.persist();
      this.scheduleRetry();
      return "retry";
    }
  }

  private async exportKeepaliveBatch(batch: readonly TelemetryEvent[]): Promise<void> {
    try {
      await this.options.exporter?.(batch.map(toJourneyIntakeEvent), { keepalive: true });
      const removed = this.removePendingEvents(batch);
      if (removed.length > 0) this.recordExportSuccess(removed.length);
      await this.persist();
    } catch (error) {
      this.exportFailed(error);
    } finally {
      this.deactivateKeepaliveBatch(batch);
    }
  }

  private removeExportedBatch(batch: readonly TelemetryEvent[]): TelemetryEvent[] {
    const removed = this.removePendingEvents(batch);
    this.deactivateNormalBatch(batch);
    return removed;
  }

  private deactivateNormalBatch(batch: readonly TelemetryEvent[]): void {
    for (const event of batch) this.activeNormalBatchEventIds.delete(event.event_id);
  }

  private deactivateKeepaliveBatch(batch: readonly TelemetryEvent[]): void {
    for (const event of batch) this.activeKeepaliveBatchEventIds.delete(event.event_id);
  }

  private isBatchActive(event: TelemetryEvent): boolean {
    return this.activeNormalBatchEventIds.has(event.event_id) || this.activeKeepaliveBatchEventIds.has(event.event_id);
  }

  private removePendingEvents(events: readonly TelemetryEvent[]): TelemetryEvent[] {
    const eventIds = new Set(events.map((event) => event.event_id));
    const removed = this.pending.filter((event) => eventIds.has(event.event_id));
    this.pending = this.pending.filter((event) => !eventIds.has(event.event_id));
    return removed;
  }

  private recordExportSuccess(batchSize: number): void {
    this.setHealth({
      exportedEvents: this.health.exportedEvents + batchSize,
      lastError: undefined,
      queueDepth: this.pending.length,
      status: "healthy",
    });
  }

  private recordBatchResult(result: Exclude<BatchDeliveryResult, "retry">, batch: readonly TelemetryEvent[]): void {
    if (batch.length === 0) return;
    if (result === "delivered") {
      this.recordExportSuccess(batch.length);
      return;
    }
    this.setHealth({ droppedEvents: this.health.droppedEvents + batch.length, queueDepth: this.pending.length });
    queueMicrotask(() => this.notifyDrops(batch));
  }

  private exportFailed(error: unknown): void {
    this.setHealth({
      failedBatches: this.health.failedBatches + 1,
      lastError: errorMessage(error),
      queueDepth: this.pending.length,
      status: "degraded",
    });
  }

  private async restore(): Promise<void> {
    if (!this.options.enabled || !this.options.storage) return;
    try {
      const persisted = await this.options.storage.load();
      this.mergeRestored(persisted);
    } catch (error) {
      this.setHealth({ lastError: errorMessage(error), status: "degraded" });
    }
  }

  private mergeRestored(persisted: readonly TelemetryEvent[]): void {
    const restored = persisted.filter((event) => !this.knownEventIds.has(event.event_id));
    for (const event of restored) this.trackEventID(event.event_id);
    this.pending = [...restored, ...this.pending];
    this.handleQueueOverflow();
    this.setHealth({ queueDepth: this.pending.length });
    if (this.pending.length > 0) this.scheduleBatchFlush();
  }

  private scheduleBatchFlush(): void {
    if (!this.canScheduleBatchFlush()) return;
    if (this.pending.length >= this.batchSize) return this.flushFullBatch();
    this.startBatchTimer();
  }

  private canScheduleBatchFlush(): boolean {
    return this.batchFlushIsAvailable() && this.batchTimerAllowsFlush();
  }

  private batchFlushIsAvailable(): boolean {
    return !this.disposed && !this.retryTimer && !this.flushInFlight;
  }

  private batchTimerAllowsFlush(): boolean {
    return this.pending.length >= this.batchSize || !this.batchTimer;
  }

  private flushFullBatch(): void {
    this.cancelBatchTimer();
    void this.flush();
  }

  private startBatchTimer(): void {
    this.batchTimer = setTimeout(() => {
      this.batchTimer = undefined;
      void this.flush();
    }, NORMAL_FLUSH_DELAY_MS);
    const nodeTimer = this.batchTimer as unknown as { unref?: () => void };
    nodeTimer.unref?.();
  }

  private cancelBatchTimer(): void {
    if (!this.batchTimer) return;
    clearTimeout(this.batchTimer);
    this.batchTimer = undefined;
  }

  private persist(): Promise<void> {
    if (!this.options.storage || !this.options.enabled) return Promise.resolve();
    this.persistence = this.persistence
      .catch(() => undefined)
      .then(async () => {
        await this.loading;
        await this.options.storage?.save([...this.pending]);
      })
      .catch((error) => this.setHealth({ lastError: errorMessage(error), status: "degraded" }));
    return this.persistence;
  }

  private scheduleRetry(): void {
    if (this.disposed || this.retryTimer) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      void this.flush();
    }, this.options.retryDelayMs);
    const nodeTimer = this.retryTimer as unknown as { unref?: () => void };
    nodeTimer.unref?.();
  }

  private setHealth(update: Partial<TelemetryExporterHealth>): void {
    this.health = { ...this.health, ...update };
    for (const listener of this.healthListeners) {
      try {
        listener(this.getHealth());
      } catch {
        // Exporter health listeners are diagnostic-only.
      }
    }
  }
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
  const body = journeyIntakeBody([event, ...batch].map(toJourneyIntakeEvent));
  return encodedByteLength(body) <= MAX_KEEPALIVE_BODY_BYTES;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Telemetry exporter failed";
}
