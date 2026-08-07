import { fingerprintDiagnosticFilter, type AcceptedDiagnosticEvent, type DiagnosticFilterV1, type DiagnosticOperationDetail, type DiagnosticSnapshotV1, type DiagnosticStreamDeltaV1 } from "@chalk/diagnostics-contracts";
import { EpisodeDiagnosticsApiClient, EpisodeDiagnosticsStreamClosedError } from "./api-client";
import { abortableDelay } from "./controller-utils";

export type DiagnosticStreamPhase = "loading" | "connecting" | "live" | "reconnecting" | "stalled" | "disconnected" | "failed";

export type DiagnosticLiveState = Readonly<{
  snapshot?: DiagnosticSnapshotV1;
  events: readonly AcceptedDiagnosticEvent[];
  operations: readonly DiagnosticOperationDetail[];
  visibleGaps: readonly Readonly<{ fromCursor: number; toCursor: number; reason: string }>[];
  phase: DiagnosticStreamPhase;
  lastAppliedCursor: number;
  filterFingerprint: string;
  reconnectAttempt: number;
  lastActivityAt?: number;
  fillingGap?: Readonly<{ fromCursor: number; toCursor: number }>;
  eventPage: DiagnosticPageState;
  operationPage: DiagnosticPageState;
  error?: string;
}>;

export type DiagnosticPageState = Readonly<{
  hasMore: boolean;
  loading: boolean;
  loadedCount: number;
  capacity: number;
  nextCursor?: number;
  error?: string;
}>;

export const createInitialDiagnosticLiveState = (filter: DiagnosticFilterV1, maxVisibleEvents = 1_000, maxVisibleOperations = 1_000): DiagnosticLiveState => ({
  events: [],
  operations: [],
  visibleGaps: [],
  phase: "loading",
  lastAppliedCursor: 0,
  filterFingerprint: fingerprintDiagnosticFilter(filter),
  reconnectAttempt: 0,
  eventPage: { hasMore: false, loading: false, loadedCount: 0, capacity: maxVisibleEvents },
  operationPage: { hasMore: false, loading: false, loadedCount: 0, capacity: maxVisibleOperations },
});

type LiveControllerOptions = Readonly<{
  api: EpisodeDiagnosticsApiClient;
  reference: string;
  filter: DiagnosticFilterV1;
  onChange: (state: DiagnosticLiveState) => void;
  maxVisibleEvents?: number;
  maxVisibleOperations?: number;
  initialPageSize?: number;
  maxReconnectAttempts?: number;
  stalledAfterMilliseconds?: number;
  now?: () => number;
  delay?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}>;

const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
};

const deltaIdentity = (delta: DiagnosticStreamDeltaV1): string => {
  const entity = delta.event?.eventId ?? delta.operation?.id ?? delta.issue?.id ?? delta.branch?.id ?? delta.gap?.fromCursor ?? "snapshot";
  return `${delta.cursor}:${delta.kind}:${entity}`;
};

const replaceById = <T extends Readonly<{ id: string }>>(values: readonly T[], value: T): T[] => {
  const index = values.findIndex((item) => item.id === value.id);
  if (index === -1) return [...values, value];
  const next = [...values];
  next[index] = value;
  return next;
};

export class DiagnosticLiveController {
  private readonly api: EpisodeDiagnosticsApiClient;
  private readonly reference: string;
  private readonly filter: DiagnosticFilterV1;
  private readonly onChange: (state: DiagnosticLiveState) => void;
  private readonly maxVisibleEvents: number;
  private readonly maxVisibleOperations: number;
  private readonly initialPageSize: number;
  private readonly maxReconnectAttempts: number;
  private readonly stalledAfterMilliseconds: number;
  private readonly now: () => number;
  private readonly delay: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  private readonly abortController = new AbortController();
  private readonly appliedDeltas = new Map<string, string>();
  private readonly eventFingerprints = new Map<string, string>();
  private stallTimer?: ReturnType<typeof setInterval>;
  private lastActivityAt = 0;
  private state: DiagnosticLiveState;

  constructor(options: LiveControllerOptions) {
    this.api = options.api;
    this.reference = options.reference;
    this.filter = options.filter;
    this.onChange = options.onChange;
    this.maxVisibleEvents = options.maxVisibleEvents ?? 1_000;
    this.maxVisibleOperations = options.maxVisibleOperations ?? 1_000;
    this.initialPageSize = options.initialPageSize ?? 250;
    this.maxReconnectAttempts = options.maxReconnectAttempts ?? 6;
    this.stalledAfterMilliseconds = options.stalledAfterMilliseconds ?? 35_000;
    this.now = options.now ?? Date.now;
    this.delay = options.delay ?? abortableDelay;
    this.state = createInitialDiagnosticLiveState(options.filter, this.maxVisibleEvents, this.maxVisibleOperations);
  }

  getState(): DiagnosticLiveState {
    return this.state;
  }

  async start(): Promise<void> {
    try {
      const snapshot = await this.api.readSnapshot(this.reference, this.filter, this.abortController.signal);
      if (snapshot.filterFingerprint !== this.state.filterFingerprint) {
        throw new Error("The snapshot filter fingerprint did not match the requested filters");
      }
      this.setState({
        snapshot,
        phase: "connecting",
        lastAppliedCursor: snapshot.projectedCursor,
      });
      await this.loadInitialEvidence(snapshot);
      this.lastActivityAt = this.now();
      this.stallTimer = setInterval(() => this.checkStall(), 1_000);
      await this.connectLoop();
    } catch (error) {
      if (this.abortController.signal.aborted) return;
      this.setState({ phase: "failed", error: this.errorMessage(error) });
    } finally {
      if (this.stallTimer) clearInterval(this.stallTimer);
    }
  }

  stop(): void {
    this.abortController.abort();
    if (this.stallTimer) clearInterval(this.stallTimer);
    if (this.state.phase !== "failed") this.setState({ phase: "disconnected" });
  }

  async loadMoreEvents(): Promise<void> {
    const pageState = this.state.eventPage;
    if (pageState.loading || !pageState.hasMore || pageState.nextCursor === undefined || this.state.events.length >= pageState.capacity) return;
    this.setState({ eventPage: { ...pageState, loading: true, error: undefined } });
    try {
      const page = await this.api.readEvents(this.reference, { after: pageState.nextCursor, limit: Math.min(this.initialPageSize, pageState.capacity - this.state.events.length), filter: this.filter }, this.abortController.signal);
      this.assertPageFingerprint(page.filterFingerprint, "Event page");
      const events = this.mergeEvents(this.state.events, page.events);
      this.setState({
        events,
        eventPage: {
          hasMore: page.hasMore,
          loading: false,
          loadedCount: events.length,
          capacity: pageState.capacity,
          ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
        },
      });
    } catch (error) {
      this.setState({ eventPage: { ...this.state.eventPage, loading: false, error: this.errorMessage(error) } });
    }
  }

  async loadMoreOperations(): Promise<void> {
    const pageState = this.state.operationPage;
    if (pageState.loading || !pageState.hasMore || pageState.nextCursor === undefined || this.state.operations.length >= pageState.capacity) return;
    this.setState({ operationPage: { ...pageState, loading: true, error: undefined } });
    try {
      const page = await this.api.readOperations(this.reference, { after: pageState.nextCursor, limit: Math.min(this.initialPageSize, pageState.capacity - this.state.operations.length), filter: this.filter }, this.abortController.signal);
      this.assertPageFingerprint(page.filterFingerprint, "Operation page");
      const operations = this.mergeOperations(this.state.operations, page.operations);
      this.setState({
        operations,
        operationPage: {
          hasMore: page.hasMore,
          loading: false,
          loadedCount: operations.length,
          capacity: pageState.capacity,
          ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
        },
      });
    } catch (error) {
      this.setState({ operationPage: { ...this.state.operationPage, loading: false, error: this.errorMessage(error) } });
    }
  }

  private async loadInitialEvidence(snapshot: DiagnosticSnapshotV1): Promise<void> {
    this.setState({
      eventPage: { ...this.state.eventPage, loading: true },
      operationPage: { ...this.state.operationPage, loading: true },
    });
    const eventAfter = Math.max(0, (this.filter.fromCursor ?? 1) - 1);
    const [eventPage, operationPage] = await Promise.all([
      this.api.readEvents(this.reference, { after: eventAfter, limit: this.initialPageSize, filter: this.filter }, this.abortController.signal),
      this.api.readOperations(this.reference, { after: 0, limit: this.initialPageSize, filter: this.filter }, this.abortController.signal),
    ]);
    this.assertPageFingerprint(eventPage.filterFingerprint, "Initial Event page");
    this.assertPageFingerprint(operationPage.filterFingerprint, "Initial operation page");
    const events = this.mergeEvents([], eventPage.events);
    const operations = this.mergeOperations(snapshot.operations, operationPage.operations);
    this.setState({
      events,
      operations,
      eventPage: {
        hasMore: eventPage.hasMore,
        loading: false,
        loadedCount: events.length,
        capacity: this.maxVisibleEvents,
        ...(eventPage.nextCursor === undefined ? {} : { nextCursor: eventPage.nextCursor }),
      },
      operationPage: {
        hasMore: operationPage.hasMore,
        loading: false,
        loadedCount: operations.length,
        capacity: this.maxVisibleOperations,
        ...(operationPage.nextCursor === undefined ? {} : { nextCursor: operationPage.nextCursor }),
      },
    });
  }

  private async connectLoop(): Promise<void> {
    while (!this.abortController.signal.aborted) {
      const reconnecting = this.state.reconnectAttempt > 0;
      this.setState({ phase: reconnecting ? "reconnecting" : "connecting" });
      let resumableCursor: number | undefined;
      try {
        for await (const delta of this.api.stream(this.reference, this.state.lastAppliedCursor, this.filter, this.abortController.signal, () => this.recordActivity())) {
          this.recordActivity();
          await this.acceptDelta(delta);
          this.setState({ phase: "live", reconnectAttempt: 0, error: undefined });
        }
        if (this.abortController.signal.aborted) return;
      } catch (error) {
        if (this.abortController.signal.aborted) return;
        if (error instanceof EpisodeDiagnosticsStreamClosedError && error.refillRequired) {
          resumableCursor = error.resumableCursor;
          this.setState({
            visibleGaps: [...this.state.visibleGaps, { fromCursor: this.state.lastAppliedCursor + 1, toCursor: error.resumableCursor, reason: error.reason }].slice(-25),
          });
        }
        this.setState({ error: this.errorMessage(error) });
      }

      const attempt = this.state.reconnectAttempt + 1;
      if (attempt > this.maxReconnectAttempts) {
        this.setState({ phase: "disconnected", reconnectAttempt: this.maxReconnectAttempts, error: this.state.error ?? "The evidence stream exhausted its reconnect budget" });
        return;
      }
      this.setState({ phase: "reconnecting", reconnectAttempt: attempt });
      await this.delay(Math.min(250 * 2 ** (attempt - 1), 5_000), this.abortController.signal);
      const latest = await this.api.readSnapshot(this.reference, this.filter, this.abortController.signal);
      const refillCursor = Math.max(latest.projectedCursor, resumableCursor ?? 0);
      if (refillCursor > this.state.lastAppliedCursor) {
        await this.refillThrough(refillCursor);
      } else {
        this.setState({ snapshot: latest, operations: this.mergeOperations(this.state.operations, latest.operations) });
      }
    }
  }

  private async acceptDelta(delta: DiagnosticStreamDeltaV1): Promise<void> {
    if (delta.reference !== this.reference) {
      throw new Error("The live stream changed Diagnostic Reference");
    }
    if (delta.filterFingerprint !== this.state.filterFingerprint) {
      throw new Error("The live stream filter fingerprint changed");
    }
    if (delta.cursor > this.state.lastAppliedCursor + 1) {
      await this.refillThrough(delta.cursor - 1);
      if (this.state.lastAppliedCursor >= delta.cursor) return;
    }
    if (delta.cursor < this.state.lastAppliedCursor) {
      const known = this.appliedDeltas.get(deltaIdentity(delta));
      if (known === canonical(delta)) return;
      throw new Error("The live stream replayed an unknown older delta");
    }

    const identity = deltaIdentity(delta);
    const fingerprint = canonical(delta);
    const appliedFingerprint = this.appliedDeltas.get(identity);
    if (appliedFingerprint === fingerprint) return;
    if (appliedFingerprint !== undefined) {
      throw new Error("The live stream changed a previously applied delta");
    }
    this.remember(this.appliedDeltas, identity, fingerprint, 5_000);

    if (delta.gap) {
      if (delta.gap.fromCursor > delta.gap.toCursor) throw new Error("The live stream sent an inverted visibility gap");
      const visibleGaps = [...this.state.visibleGaps, delta.gap].slice(-25);
      this.setState({ visibleGaps });
      const targetCursor = Math.max(delta.cursor, delta.gap.toCursor);
      if (targetCursor <= this.state.lastAppliedCursor) await this.refreshSnapshotAtLeast(targetCursor);
      else await this.refillThrough(targetCursor);
      return;
    }

    if (delta.event) this.acceptEvent(delta.event);
    let snapshot = this.state.snapshot;
    if (delta.snapshot) {
      if (delta.snapshot.filterFingerprint !== this.state.filterFingerprint) {
        throw new Error("A streamed snapshot changed the filter fingerprint");
      }
      snapshot = delta.snapshot;
    }
    if (snapshot && delta.operation) {
      snapshot = { ...snapshot, operations: replaceById(snapshot.operations, delta.operation) };
    }
    if (snapshot && delta.issue) {
      snapshot = { ...snapshot, issues: replaceById(snapshot.issues, delta.issue) };
    }
    if (snapshot && delta.branch) {
      snapshot = { ...snapshot, branches: replaceById(snapshot.branches, delta.branch) };
    }
    const lastAppliedCursor = Math.max(this.state.lastAppliedCursor, delta.cursor);
    const operations = delta.operation ? this.mergeOperations(this.state.operations, [delta.operation]) : this.state.operations;
    this.setState({ snapshot, operations, lastAppliedCursor });
    if (delta.kind !== "event_appended") await this.refreshSnapshotAtLeast(delta.cursor);
  }

  private acceptEvent(event: AcceptedDiagnosticEvent): void {
    const known = this.eventFingerprints.get(event.eventId);
    if (known === event.fingerprint) return;
    if (known !== undefined) {
      throw new Error("A Diagnostic Event ID was reused with a different fingerprint");
    }
    this.remember(this.eventFingerprints, event.eventId, event.fingerprint, 5_000);
    const events = this.mergeEvents(this.state.events, [event]).slice(-this.maxVisibleEvents);
    this.setState({ events });
  }

  private async refillThrough(targetCursor: number): Promise<void> {
    if (targetCursor <= this.state.lastAppliedCursor) return;
    const fromCursor = this.state.lastAppliedCursor;
    this.setState({ fillingGap: { fromCursor: fromCursor + 1, toCursor: targetCursor } });
    let cursor = fromCursor;
    while (cursor < targetCursor) {
      const page = await this.api.readEvents(this.reference, { after: cursor, limit: 1_000, filter: this.filter }, this.abortController.signal);
      if (page.filterFingerprint !== this.state.filterFingerprint) {
        throw new Error("A durable gap page had a mismatched filter fingerprint");
      }
      for (const event of page.events) this.acceptEvent(event);
      const nextCursor = Math.min(targetCursor, page.nextCursor ?? page.events.at(-1)?.cursor ?? cursor);
      if (nextCursor <= cursor) break;
      cursor = nextCursor;
    }

    await this.refreshSnapshotAtLeast(targetCursor);
    this.setState({ fillingGap: undefined });
  }

  private async refreshSnapshotAtLeast(targetCursor: number): Promise<void> {
    const snapshot = await this.api.readSnapshot(this.reference, this.filter, this.abortController.signal);
    this.assertPageFingerprint(snapshot.filterFingerprint, "Refreshed snapshot");
    if (snapshot.projectedCursor < targetCursor) throw new Error("The refreshed projection had not reached the durable cursor");
    this.setState({
      snapshot,
      operations: this.mergeOperations(this.state.operations, snapshot.operations),
      lastAppliedCursor: Math.max(this.state.lastAppliedCursor, targetCursor, snapshot.projectedCursor),
    });
  }

  private mergeEvents(current: readonly AcceptedDiagnosticEvent[], incoming: readonly AcceptedDiagnosticEvent[]): AcceptedDiagnosticEvent[] {
    const byEventId = new Map(current.map((event) => [event.eventId, event]));
    for (const event of incoming) {
      const known = byEventId.get(event.eventId);
      if (known && known.fingerprint !== event.fingerprint) throw new Error("A Diagnostic Event ID was reused with a different fingerprint");
      byEventId.set(event.eventId, event);
      this.remember(this.eventFingerprints, event.eventId, event.fingerprint, 5_000);
    }
    return [...byEventId.values()].sort((left, right) => left.cursor - right.cursor).slice(-this.maxVisibleEvents);
  }

  private mergeOperations(current: readonly DiagnosticOperationDetail[], incoming: readonly DiagnosticOperationDetail[]): DiagnosticOperationDetail[] {
    const byId = new Map(current.map((operation) => [operation.id, operation]));
    for (const operation of incoming) byId.set(operation.id, operation);
    return [...byId.values()].slice(-this.maxVisibleOperations);
  }

  private assertPageFingerprint(fingerprint: string, label: string): void {
    if (fingerprint !== this.state.filterFingerprint) throw new Error(`${label} had a mismatched filter fingerprint`);
  }

  private recordActivity(): void {
    this.lastActivityAt = this.now();
    const isConnected = this.state.phase === "connecting" || this.state.phase === "reconnecting" || this.state.phase === "stalled";
    this.setState({ lastActivityAt: this.lastActivityAt, ...(isConnected ? { phase: "live" as const } : {}) });
  }

  private checkStall(): void {
    if ((this.state.phase === "live" || this.state.phase === "connecting") && this.now() - this.lastActivityAt > this.stalledAfterMilliseconds) {
      this.setState({ phase: "stalled" });
    }
  }

  private setState(update: Partial<DiagnosticLiveState>): void {
    this.state = { ...this.state, ...update };
    this.onChange(this.state);
  }

  private remember(map: Map<string, string>, key: string, value: string, limit: number): void {
    map.set(key, value);
    if (map.size <= limit) return;
    const oldest = map.keys().next().value as string | undefined;
    if (oldest !== undefined) map.delete(oldest);
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : "The diagnostic stream failed";
  }
}
