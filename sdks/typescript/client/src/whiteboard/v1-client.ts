import { WhiteboardV1ProtocolLimits, type WhiteboardV1ClientFrame, type WhiteboardV1Element, type WhiteboardV1ServerFrame } from "../generated/whiteboard-v1";
import type { SyncSocket } from "../sync/types";
import {
  ChalkWhiteboardV1Error,
  type ChalkSharedWhiteboardAppState,
  type ChalkWhiteboardV1Capability,
  type ChalkWhiteboardV1ClientOptions,
  type ChalkWhiteboardV1Commit,
  type ChalkWhiteboardV1Element,
  type ChalkWhiteboardV1Event,
  type ChalkWhiteboardV1Failure,
  type ChalkWhiteboardV1Operation,
  type ChalkWhiteboardV1PendingOperation,
  type ChalkWhiteboardSummary,
  type ChalkWhiteboardV1Transport,
  type ChalkWhiteboardV1UpdateInput,
} from "./types";
import { decodeWhiteboardV1ServerFrame, encodeWhiteboardV1ClientFrame } from "./v1-codec";
import { WhiteboardV1UpdateAssembler, whiteboardV1OperationFrames, whiteboardV1PendingOperationBytes } from "./v1-multipart";
import { compareChalkWhiteboardV1PendingOperations, InMemoryChalkWhiteboardV1PendingOperationStore } from "./v1-persistence";

const CLIENT_RESTART_CLOSE_CODE = 4000;
const DEPENDENCY_UNAVAILABLE_CLOSE_CODE = 1012;
const HEARTBEAT_INTERVAL_MS = 20_000;
const MAX_MISSED_HEARTBEATS = 2;
const encoder = new TextEncoder();

type Deferred<T> = {
  readonly resolve: (value: T) => void;
  readonly reject: (error: Error) => void;
  settled: boolean;
};

type OperationEntry = {
  readonly pending: ChalkWhiteboardV1PendingOperation;
  readonly deferred?: Deferred<ChalkWhiteboardV1Commit>;
  retries: number;
};

type SnapshotAssembly = {
  readonly requestId: string;
  readonly deferred: Deferred<void>;
  readonly promise: Promise<void>;
  sceneId?: string;
  revision?: string;
  pageCount?: number;
  appState?: ChalkSharedWhiteboardAppState;
  readonly pages: Map<number, readonly ChalkWhiteboardV1Element[]>;
};

type SnapshotPageFrame = Extract<WhiteboardV1ServerFrame, { readonly type: "snapshot_page" }>;

export class ChalkWhiteboardV1Client implements ChalkWhiteboardV1Transport {
  readonly files;
  readonly #options: ChalkWhiteboardV1ClientOptions;
  readonly #store;
  readonly #listeners = new Set<(event: ChalkWhiteboardV1Event) => void>();
  readonly #operations = new Map<string, OperationEntry>();
  readonly #reservedOperationIds = new Set<string>();
  readonly #awaitingOperationIds = new Set<string>();
  readonly #pendingStoreWrites = new Set<Promise<void>>();
  readonly #operationRetryTimers = new Map<string, unknown>();
  readonly #snapshots = new Map<string, SnapshotAssembly>();
  readonly #snapshotBlockedOperationIds = new Set<string>();
  readonly #updateAssembler = new WhiteboardV1UpdateAssembler();
  readonly #updateAssemblyTimers = new Map<string, unknown>();
  #socket: SyncSocket | null = null;
  #started = false;
  #startupGeneration = 0;
  #phase: "idle" | "connecting" | "authenticating" | "live" | "stopped" = "idle";
  #participantId: string | null = null;
  #sceneId: string | null;
  #revision: string | null;
  #capabilities: readonly ChalkWhiteboardV1Capability[] = [];
  #canDraw = false;
  #presentationSupported = false;
  #presenting = false;
  #useLegacyHello = false;
  #summaryStatus: ChalkWhiteboardSummary["status"] = "unsubscribed";
  #summaryError: ChalkWhiteboardV1Failure | null = null;
  #latestSnapshot: Extract<ChalkWhiteboardV1Event, { readonly type: "snapshot" }> | null = null;
  #initialSnapshot: Deferred<void> | null = null;
  #startPromise: Promise<void> | null = null;
  #stopPromise: Promise<void> | null = null;
  #waitingForOperations = false;
  #reconnectTimer: unknown;
  #heartbeatTimer: unknown;
  #missedHeartbeats = 0;
  #lastCursorAt = Number.NEGATIVE_INFINITY;
  #unsubscribeLifecycle: (() => void) | undefined;
  #transportAvailable = true;
  #online = true;
  #active = true;
  #inbound = Promise.resolve();

  constructor(options: ChalkWhiteboardV1ClientOptions) {
    assertWhiteboardV1Url(options.url);
    this.#options = options;
    this.files = options.files;
    this.#store = options.pendingStore ?? new InMemoryChalkWhiteboardV1PendingOperationStore();
    this.#sceneId = options.cursor?.sceneId ?? null;
    this.#revision = options.cursor?.revision ?? null;
  }

  startSceneSubscription(): Promise<void> {
    if (this.#stopPromise) return this.#stopPromise.then(() => this.startSceneSubscription());
    if (this.#started && this.#startPromise) return this.#startPromise;
    this.#started = true;
    this.#useLegacyHello = false;
    this.#phase = "connecting";
    this.#publishSummary("loading", null);
    const generation = ++this.#startupGeneration;
    this.#startPromise = new Promise<void>((resolve, reject) => {
      this.#initialSnapshot = { resolve, reject, settled: false };
    });
    void this.#restoreAndConnect(generation);
    return this.#startPromise;
  }

  stopSceneSubscription(): Promise<void> {
    if (this.#stopPromise) return this.#stopPromise;
    if (this.#phase === "stopped" && !this.#started) return Promise.resolve();

    this.#stopPromise = Promise.resolve().then(async () => {
      while (this.#pendingStoreWrites.size > 0) {
        await Promise.allSettled([...this.#pendingStoreWrites]);
      }
      this.#stopNow();
      this.#stopPromise = null;
    });
    return this.#stopPromise;
  }

  #stopNow(): void {
    this.#started = false;
    this.#startupGeneration += 1;
    this.#unsubscribeLifecycle?.();
    this.#unsubscribeLifecycle = undefined;
    this.#clearReconnect();
    this.#clearHeartbeat();
    this.#clearOperationRetryTimers();
    this.#clearUpdateAssemblies();
    this.#awaitingOperationIds.clear();
    this.#waitingForOperations = false;
    this.#socket?.close(1000, "whiteboard subscription stopped");
    this.#socket = null;
    this.#phase = "stopped";
    this.#rejectSnapshots(failure("request_snapshot", "unavailable", true, "Whiteboard subscription stopped."));
    this.#rejectOperationCallers(failure("submit_update", "unavailable", true, "Whiteboard subscription stopped."));
    if (this.#initialSnapshot) rejectDeferred(this.#initialSnapshot, error(failure("start_scene_subscription", "unavailable", true, "Whiteboard subscription stopped.")));
    this.#initialSnapshot = null;
    this.#startPromise = null;
    this.#participantId = null;
    this.#capabilities = [];
    this.#canDraw = false;
    this.#presenting = false;
    this.#publishSummary("unsubscribed", null);
  }

  subscribe(listener: (event: ChalkWhiteboardV1Event) => void): () => void {
    this.#listeners.add(listener);
    if (this.#phase !== "live") return () => this.#listeners.delete(listener);
    if (this.#latestSnapshot && this.#latestSnapshot.sceneId === this.#sceneId && this.#latestSnapshot.revision === this.#revision) {
      listener(this.#latestSnapshot);
    }
    if (this.#snapshots.size === 0 && !this.#waitingForOperations) void this.#requestSnapshot().catch(() => undefined);
    return () => this.#listeners.delete(listener);
  }

  submitUpdate(input: ChalkWhiteboardV1UpdateInput): Promise<ChalkWhiteboardV1Commit> {
    this.#assertLive("submit_update");
    if (!this.#canDraw || !this.#capabilities.includes("drawWhiteboard")) {
      throw error(failure("submit_update", "permission_denied", false, "Whiteboard draw permission is required."));
    }
    const operationId = this.#nextId();
    return this.#queueOperation({
      type: "submit_update",
      operation_id: operationId,
      scene_id: input.sceneId,
      sync_all: input.syncAll,
      elements: input.elements.map(elementToFrame),
    });
  }

  sendCursor(input: { readonly x: number; readonly y: number }): void {
    if (this.#phase !== "live" || !this.#canDraw) return;
    if (this.#snapshots.size > 0) return;
    const now = this.#now();
    if (now - this.#lastCursorAt < 1000 / WhiteboardV1ProtocolLimits.cursorRatePerSecond) return;
    const frame = { type: "cursor", x: input.x, y: input.y } as const;
    encodeWhiteboardV1ClientFrame(frame);
    this.#lastCursorAt = now;
    this.#send(frame);
  }

  requestSnapshot(): Promise<void> {
    this.#assertLive("request_snapshot");
    return this.#requestSnapshot();
  }

  clear(): Promise<ChalkWhiteboardV1Commit> {
    this.#assertLive("clear");
    if (!this.#sceneId || !this.#capabilities.includes("manageWhiteboard")) {
      throw error(failure("clear", "permission_denied", false, "Whiteboard management permission is required."));
    }
    const operationId = this.#nextId();
    return this.#queueOperation({ type: "clear", operation_id: operationId, scene_id: this.#sceneId });
  }

  async setDrawPermission(participantId: string, canDraw: boolean): Promise<void> {
    this.#assertLive("set_draw_permission");
    if (!this.#capabilities.includes("manageWhiteboard")) {
      throw error(failure("set_draw_permission", "permission_denied", false, "Whiteboard management permission is required."));
    }
    const operationId = this.#nextId();
    const frame = {
      type: "set_draw_permission",
      operation_id: operationId,
      participant_id: participantId,
      can_draw: canDraw,
    } as Extract<WhiteboardV1ClientFrame, { readonly type: "set_draw_permission" }>;
    await this.#queueOperation(frame);
  }

  async setPresentation(presenting: boolean): Promise<void> {
    if (!this.#started || this.#phase === "idle" || this.#phase === "stopped") {
      throw error(failure("set_presentation", "unavailable", true, "Whiteboard is not connected."));
    }
    if (!this.#presentationSupported) {
      throw error(failure("set_presentation", "unavailable", true, "Whiteboard presentation is unavailable on this Sync server."));
    }
    if (this.#phase === "live" && (!this.#canDraw || !this.#capabilities.includes("drawWhiteboard"))) {
      throw error(failure("set_presentation", "permission_denied", false, "Whiteboard draw permission is required."));
    }
    const frame = {
      type: "set_presentation",
      operation_id: this.#nextId(),
      presenting,
    } as Extract<WhiteboardV1ClientFrame, { readonly type: "set_presentation" }>;
    await this.#queueOperation(frame);
  }

  async #restoreAndConnect(generation: number): Promise<void> {
    try {
      const stored = await this.#store.load();
      if (!this.#isCurrentStartup(generation)) return;
      this.#restorePendingOperations(stored);
      this.#unsubscribeLifecycle = this.#options.lifecycle?.subscribe((event) => this.#handleLifecycle(event));
      this.#connect();
    } catch (cause) {
      if (this.#isCurrentStartup(generation)) this.#failStartup(cause);
    }
  }

  #isCurrentStartup(generation: number): boolean {
    return this.#started && generation === this.#startupGeneration;
  }

  #restorePendingOperations(stored: readonly ChalkWhiteboardV1PendingOperation[]): void {
    for (const pending of [...stored].sort(compareChalkWhiteboardV1PendingOperations)) {
      if (!this.#validRestoredOperation(pending)) {
        void this.#store.remove(pending.operationId).catch(() => undefined);
        continue;
      }
      if (this.#operations.size >= WhiteboardV1ProtocolLimits.pendingOperationMaxItems) return;
      this.#operations.set(pending.operationId, { pending, retries: 0 });
    }
  }

  #validRestoredOperation(pending: ChalkWhiteboardV1PendingOperation): boolean {
    try {
      whiteboardV1OperationFrames(pending.frame);
      return pending.operationId === pending.frame.operation_id && pending.bytes === whiteboardV1PendingOperationBytes(pending.frame);
    } catch {
      return false;
    }
  }

  #failStartup(cause: unknown): void {
    const startupFailure = failure("start_scene_subscription", "unavailable", true, "Unable to restore whiteboard retry state.");
    this.#started = false;
    this.#phase = "idle";
    this.#publishSummary("failed", startupFailure);
    if (this.#initialSnapshot) rejectDeferred(this.#initialSnapshot, error(startupFailure, cause));
  }

  #connect(): void {
    if (!this.#started || !this.#transportAvailable || this.#socket) return;
    this.#phase = "connecting";
    const socket = this.#options.webSocket.connect(this.#options.url);
    this.#socket = socket;
    socket.onopen = () => void this.#authenticate(socket);
    socket.onmessage = (event) => {
      this.#inbound = this.#inbound.then(() => this.#receive(socket, event.data));
    };
    socket.onclose = (event) => this.#disconnected(socket, event.code);
    socket.onerror = () => socket.close(CLIENT_RESTART_CLOSE_CODE, "whiteboard transport error");
  }

  async #authenticate(socket: SyncSocket): Promise<void> {
    try {
      const token = await this.#options.token();
      if (socket !== this.#socket) return;
      this.#phase = "authenticating";
      const cursor = this.#sceneId && this.#revision ? { scene_id: this.#sceneId, revision: this.#revision } : null;
      this.#send(this.#useLegacyHello ? { type: "hello", protocol: "whiteboard-v1", token, cursor } : { type: "hello", protocol: "whiteboard-v1", token, cursor, extensions: [{ name: "presentation_v1" }] });
    } catch {
      socket.close(1008, "whiteboard authentication failed");
    }
  }

  async #receive(socket: SyncSocket, data: unknown): Promise<void> {
    if (socket !== this.#socket) return;
    try {
      if (typeof data !== "string" || encoder.encode(data).byteLength > WhiteboardV1ProtocolLimits.encodedOutboundFrameBytes) {
        throw new Error("invalid whiteboard frame size");
      }
      this.#handleFrame(decodeWhiteboardV1ServerFrame(data));
    } catch {
      socket.close(1009, "invalid whiteboard frame");
    }
  }

  // This switch exhausts the generated whiteboard-v1 discriminated union.
  // fallow-ignore-next-line complexity
  #handleFrame(frame: WhiteboardV1ServerFrame): void {
    switch (frame.type) {
      case "welcome":
        this.#welcome(frame);
        return;
      case "snapshot_page":
        this.#snapshotPage(frame);
        return;
      case "update":
        this.#update(frame);
        return;
      case "update_part":
        this.#updatePart(frame);
        return;
      case "commit":
        this.#commit(frame);
        return;
      case "cursor":
        this.#requireLive();
        this.#emit({
          type: "cursor",
          participantId: frame.participant_id,
          displayName: frame.display_name,
          x: frame.x,
          y: frame.y,
          occurredAt: frame.occurred_at,
        });
        return;
      case "permission_updated":
        this.#requireLive();
        if (frame.participant_id === this.#participantId) this.#canDraw = frame.can_draw;
        this.#publishSummary("ready", null);
        return;
      case "presentation_updated":
        this.#requireLive();
        this.#sceneId = frame.scene_id;
        this.#revision = frame.revision;
        this.#presenting = frame.presenting;
        this.#publishSummary("ready", null);
        return;
      case "reset_required":
        this.#requireLive();
        this.#sceneId = frame.scene_id;
        this.#revision = null;
        this.#publishSummary("recovering", failure("request_snapshot", "cursor_reset_required", true, "Whiteboard snapshot recovery is required."));
        if (this.#presentationSupported) {
          this.#socket?.close(CLIENT_RESTART_CLOSE_CODE, "whiteboard presentation recovery required");
          return;
        }
        this.#emit({ type: "reset_required", sceneId: frame.scene_id, reason: frame.reason });
        return;
      case "operation_error":
        this.#operationError(frame);
        return;
      case "pong":
        this.#requireLive();
        this.#missedHeartbeats = 0;
        return;
    }
  }

  #update(frame: Extract<WhiteboardV1ServerFrame, { readonly type: "update" }>): void {
    this.#requireLive();
    this.#sceneId = frame.scene_id;
    this.#revision = frame.revision;
    this.#publishSummary("ready", null);
    this.#emit({
      type: "update",
      sceneId: frame.scene_id,
      revision: frame.revision,
      elements: frame.elements.map(elementFromFrame),
    });
  }

  #updatePart(frame: Extract<WhiteboardV1ServerFrame, { readonly type: "update_part" }>): void {
    this.#requireLive();
    const result = this.#updateAssembler.add(frame);
    if (result.status === "incomplete") {
      if (result.started) {
        const timer = this.#clock().setTimeout(() => this.#expireUpdateAssembly(result.key), WhiteboardV1ProtocolLimits.multipartUpdateTimeoutMs);
        this.#updateAssemblyTimers.set(result.key, timer);
      }
      return;
    }

    this.#clearUpdateAssemblyTimer(result.key);
    this.#update(result.frame);
  }

  #expireUpdateAssembly(key: string): void {
    this.#updateAssemblyTimers.delete(key);
    this.#updateAssembler.discard(key);
    if (this.#phase !== "live") return;
    const incomplete = failure("request_snapshot", "cursor_reset_required", true, "Whiteboard multipart update recovery is required.");
    this.#publishSummary("recovering", incomplete);
    void this.#requestSnapshot().catch(() => undefined);
  }

  #welcome(frame: Extract<WhiteboardV1ServerFrame, { readonly type: "welcome" }>): void {
    if (this.#phase !== "authenticating") throw new Error("unexpected whiteboard welcome");
    this.#phase = "live";
    this.#participantId = frame.participant_id;
    this.#sceneId = frame.scene_id;
    this.#revision = frame.revision;
    this.#capabilities = [...frame.capabilities];
    this.#canDraw = frame.can_draw;
    this.#presentationSupported = "presenting" in frame;
    this.#presenting = "presenting" in frame ? frame.presenting : false;
    this.#publishSummary("loading", null);
    this.#missedHeartbeats = 0;
    const pendingOperations = [...this.#operations.values()].sort((left, right) => compareChalkWhiteboardV1PendingOperations(left.pending, right.pending));
    this.#awaitingOperationIds.clear();
    this.#waitingForOperations = true;
    for (const entry of pendingOperations) this.#awaitingOperationIds.add(entry.pending.operationId);
    for (const entry of pendingOperations) {
      this.#sendOperation(entry.pending.frame);
    }
    this.#requestSnapshotAfterOperations();
    this.#startHeartbeat();
  }

  #requestSnapshotAfterOperations(): void {
    if (this.#phase !== "live" || !this.#waitingForOperations || this.#awaitingOperationIds.size > 0) return;
    this.#waitingForOperations = false;
    void this.#requestSnapshot().catch(() => undefined);
  }

  #requestSnapshot(): Promise<void> {
    for (const snapshot of this.#snapshots.values()) return snapshot.promise;
    const requestId = this.#nextId();
    const frame = { type: "request_snapshot", request_id: requestId } as const;
    encodeWhiteboardV1ClientFrame(frame);
    let deferred!: Deferred<void>;
    const promise = new Promise<void>((resolve, reject) => {
      deferred = { resolve, reject, settled: false };
    });
    this.#snapshots.set(requestId, { requestId, deferred, promise, pages: new Map() });
    this.#send(frame);
    return promise;
  }

  #snapshotPage(frame: SnapshotPageFrame): void {
    this.#requireLive();
    const assembly = this.#snapshots.get(frame.request_id);
    if (!assembly) return;
    assertConsistentSnapshotPage(assembly, frame);
    assembly.sceneId = frame.scene_id;
    assembly.revision = frame.revision;
    assembly.pageCount = frame.page_count;
    if (frame.app_state) assembly.appState = { viewBackgroundColor: frame.app_state.view_background_color };
    assembly.pages.set(frame.page, frame.elements.map(elementFromFrame));
    this.#ackSnapshotPage(frame);
    if (assembly.pages.size !== frame.page_count) return;
    this.#completeSnapshot(frame, assembly, assembleSnapshotElements(assembly, frame.page_count));
  }

  #ackSnapshotPage(frame: SnapshotPageFrame): void {
    this.#send({
      type: "snapshot_ack",
      request_id: frame.request_id,
      scene_id: frame.scene_id,
      revision: frame.revision,
      page: frame.page,
    });
  }

  #completeSnapshot(frame: SnapshotPageFrame, assembly: SnapshotAssembly, elements: readonly ChalkWhiteboardV1Element[]): void {
    this.#snapshots.delete(frame.request_id);
    this.#sceneId = frame.scene_id;
    this.#revision = frame.revision;
    this.#publishSummary("ready", null);
    this.#emit({
      type: "snapshot",
      sceneId: frame.scene_id,
      revision: frame.revision,
      elements,
      ...(assembly.appState ? { appState: assembly.appState } : {}),
    });
    resolveDeferred(assembly.deferred, undefined);
    if (this.#initialSnapshot) {
      resolveDeferred(this.#initialSnapshot, undefined);
      this.#initialSnapshot = null;
    }
    this.#flushSnapshotBlockedOperations();
  }

  async #queueOperation(frame: Extract<WhiteboardV1ClientFrame, { readonly type: "submit_update" | "clear" | "set_draw_permission" | "set_presentation" }>): Promise<ChalkWhiteboardV1Commit> {
    this.#assertOperationCapacity();
    whiteboardV1OperationFrames(frame);
    const snapshotInFlight = this.#snapshots.size > 0;
    const pending = {
      operationId: frame.operation_id,
      frame,
      createdAt: this.#now(),
      bytes: whiteboardV1PendingOperationBytes(frame),
    } satisfies ChalkWhiteboardV1PendingOperation;
    const queuedBytes = [...this.#operations.values()].reduce((total, entry) => total + entry.pending.bytes, 0);
    if (queuedBytes + pending.bytes > WhiteboardV1ProtocolLimits.multipartUpdateMaxBytes) {
      throw error(failure("submit_update", "unavailable", true, "Whiteboard operation byte capacity is full."));
    }
    this.#reservedOperationIds.add(frame.operation_id);
    let storeWrite: Promise<void>;
    try {
      storeWrite = this.#store.put(pending);
    } catch (cause) {
      throw error(failure(operationName(frame), "unavailable", true, "Unable to persist the whiteboard operation."), cause);
    }
    this.#pendingStoreWrites.add(storeWrite);
    try {
      await storeWrite;
    } catch (cause) {
      throw error(failure(operationName(frame), "unavailable", true, "Unable to persist the whiteboard operation."), cause);
    } finally {
      this.#pendingStoreWrites.delete(storeWrite);
      this.#reservedOperationIds.delete(frame.operation_id);
    }
    let deferred!: Deferred<ChalkWhiteboardV1Commit>;
    const promise = new Promise<ChalkWhiteboardV1Commit>((resolve, reject) => {
      deferred = { resolve, reject, settled: false };
    });
    this.#operations.set(frame.operation_id, { pending, deferred, retries: 0 });
    if (this.#phase === "live") {
      if (snapshotInFlight || this.#snapshots.size > 0) {
        this.#snapshotBlockedOperationIds.add(frame.operation_id);
        this.#flushSnapshotBlockedOperations();
      } else this.#sendOperation(frame);
    }
    return promise;
  }

  #commit(frame: Extract<WhiteboardV1ServerFrame, { readonly type: "commit" }>): void {
    this.#requireLive();
    const entry = this.#operations.get(frame.operation_id);
    if (!entry) return;
    this.#snapshotBlockedOperationIds.delete(frame.operation_id);
    this.#operations.delete(frame.operation_id);
    this.#clearOperationRetryTimer(frame.operation_id);
    this.#sceneId = frame.scene_id;
    this.#revision = frame.revision;
    this.#awaitingOperationIds.delete(frame.operation_id);
    this.#publishSummary("ready", null);
    entry.deferred &&
      resolveDeferred(entry.deferred, {
        operationId: frame.operation_id,
        sceneId: frame.scene_id,
        revision: frame.revision,
      });
    void this.#store.remove(frame.operation_id).catch(() => undefined);
    this.#requestSnapshotAfterOperations();
  }

  #operationError(frame: Extract<WhiteboardV1ServerFrame, { readonly type: "operation_error" }>): void {
    this.#requireLive();
    const entry = this.#operations.get(frame.correlation_id);
    if (entry) {
      if (frame.recoverable && retryableOperationCode(frame.code)) {
        this.#scheduleOperationRetry(frame.correlation_id, entry);
        return;
      }
      this.#operations.delete(frame.correlation_id);
      this.#snapshotBlockedOperationIds.delete(frame.correlation_id);
      this.#clearOperationRetryTimer(frame.correlation_id);
      this.#awaitingOperationIds.delete(frame.correlation_id);
      entry.deferred && rejectDeferred(entry.deferred, error(failure(operationName(entry.pending.frame), mapErrorCode(frame.code), frame.recoverable, frame.message)));
      this.#publishSummary("ready", failure(operationName(entry.pending.frame), mapErrorCode(frame.code), frame.recoverable, frame.message));
      void this.#store.remove(frame.correlation_id).catch(() => undefined);
      this.#requestSnapshotAfterOperations();
      return;
    }
    const snapshot = this.#snapshots.get(frame.correlation_id);
    if (!snapshot) return;
    this.#snapshots.delete(frame.correlation_id);
    const snapshotError = error(failure("request_snapshot", mapErrorCode(frame.code), frame.recoverable, frame.message));
    this.#publishSummary(frame.recoverable ? "recovering" : "failed", failure("request_snapshot", mapErrorCode(frame.code), frame.recoverable, frame.message));
    rejectDeferred(snapshot.deferred, snapshotError);
    if (this.#initialSnapshot) {
      rejectDeferred(this.#initialSnapshot, snapshotError);
      this.#initialSnapshot = null;
    }
    this.#flushSnapshotBlockedOperations();
  }

  #scheduleOperationRetry(operationId: string, entry: OperationEntry): void {
    if (this.#operationRetryTimers.has(operationId)) return;
    entry.retries += 1;
    const timer = this.#clock().setTimeout(
      () => {
        this.#operationRetryTimers.delete(operationId);
        if (this.#phase === "live" && this.#operations.get(operationId) === entry) this.#sendOperation(entry.pending.frame);
      },
      this.#options.retryDelayMs ?? Math.min(100 * 2 ** Math.min(entry.retries - 1, 4), 2_000),
    );
    this.#operationRetryTimers.set(operationId, timer);
  }

  #disconnected(socket: SyncSocket, closeCode: number): void {
    if (socket !== this.#socket) return;
    const rejectedPresentationHello = this.#rejectedPresentationHello(closeCode);
    this.#resetDisconnectedState();
    if (!this.#started || !this.#transportAvailable) return;
    if (rejectedPresentationHello) {
      this.#useLegacyHello = true;
      this.#scheduleReconnect();
      return;
    }
    if (terminalCloseCode(closeCode)) {
      this.#failRejectedConnection(closeCode);
      return;
    }
    this.#scheduleReconnect();
  }

  #rejectedPresentationHello(closeCode: number): boolean {
    return this.#phase === "authenticating" && !this.#useLegacyHello && terminalCloseCode(closeCode);
  }

  #resetDisconnectedState(): void {
    this.#socket = null;
    this.#clearHeartbeat();
    this.#clearUpdateAssemblies();
    this.#phase = "connecting";
    this.#waitingForOperations = false;
    this.#participantId = null;
    this.#capabilities = [];
    this.#canDraw = false;
    this.#rejectSnapshots(failure("request_snapshot", "unavailable", true, "Whiteboard connection interrupted."));
    this.#publishSummary("recovering", failure("start_scene_subscription", "unavailable", true, "Whiteboard connection interrupted."));
  }

  #failRejectedConnection(closeCode: number): void {
    const terminalFailure = failure("start_scene_subscription", closeCode === 1008 ? "permission_denied" : "invalid_payload", false, "Whiteboard connection was rejected.");
    this.#started = false;
    this.#publishSummary("failed", terminalFailure);
    if (this.#initialSnapshot) rejectDeferred(this.#initialSnapshot, error(terminalFailure));
    this.#rejectOperationCallers(terminalFailure);
  }

  #scheduleReconnect(): void {
    this.#clearReconnect();
    this.#reconnectTimer = this.#clock().setTimeout(() => {
      this.#reconnectTimer = undefined;
      this.#connect();
    }, this.#options.reconnectDelayMs ?? 250);
  }

  #handleLifecycle(event: "online" | "offline" | "active" | "inactive"): void {
    if (event === "online" || event === "offline") this.#online = event === "online";
    else this.#active = event === "active";
    this.#transportAvailable = this.#online && this.#active;
    if (!this.#transportAvailable) this.#socket?.close(CLIENT_RESTART_CLOSE_CODE, "whiteboard lifecycle unavailable");
    else this.#connect();
  }

  #assertLive(operation: ChalkWhiteboardV1Operation): void {
    if (this.#phase !== "live") throw error(failure(operation, "unavailable", true, "Whiteboard is not connected."));
  }

  #requireLive(): void {
    if (this.#phase !== "live") throw new Error("whiteboard frame arrived before welcome");
  }

  #assertOperationCapacity(): void {
    if (this.#operations.size + this.#reservedOperationIds.size >= WhiteboardV1ProtocolLimits.pendingOperationMaxItems) {
      throw error(failure("submit_update", "unavailable", true, "Whiteboard operation capacity is full."));
    }
  }

  #nextId(): string {
    const id = this.#options.ids?.next() ?? crypto.randomUUID();
    if (this.#operations.has(id) || this.#reservedOperationIds.has(id) || this.#snapshots.has(id)) {
      throw error(failure("submit_update", "invalid_payload", false, "Whiteboard operation ID is already pending."));
    }
    return id;
  }

  #send(frame: WhiteboardV1ClientFrame): void {
    const socket = this.#socket;
    if (!socket) return;
    try {
      socket.send(encodeWhiteboardV1ClientFrame(frame));
    } catch {
      try {
        socket.close(CLIENT_RESTART_CLOSE_CODE, "whiteboard send recovery required");
      } finally {
        this.#disconnected(socket, CLIENT_RESTART_CLOSE_CODE);
      }
    }
  }

  #sendOperation(frame: ChalkWhiteboardV1PendingOperation["frame"]): void {
    for (const outbound of whiteboardV1OperationFrames(frame)) this.#send(outbound);
  }

  #emit(event: ChalkWhiteboardV1Event): void {
    if (event.type === "snapshot") this.#latestSnapshot = event;
    for (const listener of this.#listeners) listener(event);
  }

  #publishSummary(status: ChalkWhiteboardSummary["status"], summaryError: ChalkWhiteboardV1Failure | null): void {
    this.#summaryStatus = status;
    this.#summaryError = summaryError;
    const summary: ChalkWhiteboardSummary = {
      status: this.#summaryStatus,
      sceneId: this.#sceneId,
      revision: this.#revision,
      capabilities: [...this.#capabilities],
      canDraw: this.#canDraw,
      canClear: this.#capabilities.includes("manageWhiteboard"),
      presenting: this.#presenting,
      error: this.#summaryError,
    };
    try {
      this.#options.onSummary?.(summary);
    } catch {
      // Consumer summary callbacks cannot interfere with transport ownership.
    }
  }

  #startHeartbeat(): void {
    this.#clearHeartbeat();
    this.#heartbeatTimer = this.#clock().setTimeout(() => {
      this.#heartbeatTimer = undefined;
      if (this.#phase !== "live") return;
      this.#missedHeartbeats += 1;
      if (this.#missedHeartbeats > MAX_MISSED_HEARTBEATS) {
        this.#socket?.close(DEPENDENCY_UNAVAILABLE_CLOSE_CODE, "whiteboard heartbeat timeout");
        return;
      }
      this.#send({ type: "ping" });
      this.#startHeartbeat();
    }, HEARTBEAT_INTERVAL_MS);
  }

  #rejectSnapshots(value: ChalkWhiteboardV1Failure): void {
    for (const assembly of this.#snapshots.values()) rejectDeferred(assembly.deferred, error(value));
    this.#snapshots.clear();
    this.#snapshotBlockedOperationIds.clear();
  }

  #flushSnapshotBlockedOperations(): void {
    if (this.#snapshots.size > 0 || this.#phase !== "live" || this.#snapshotBlockedOperationIds.size === 0) return;
    const blockedOperationIds = [...this.#snapshotBlockedOperationIds];
    this.#snapshotBlockedOperationIds.clear();
    for (const operationId of blockedOperationIds) {
      const entry = this.#operations.get(operationId);
      if (entry) this.#sendOperation(entry.pending.frame);
    }
  }

  #rejectOperationCallers(value: ChalkWhiteboardV1Failure): void {
    for (const entry of this.#operations.values()) entry.deferred && rejectDeferred(entry.deferred, error({ ...value, operation: operationName(entry.pending.frame) }));
  }

  #clearOperationRetryTimers(): void {
    for (const timer of this.#operationRetryTimers.values()) this.#clock().clearTimeout(timer);
    this.#operationRetryTimers.clear();
  }

  #clearOperationRetryTimer(operationId: string): void {
    const timer = this.#operationRetryTimers.get(operationId);
    if (timer === undefined) return;
    this.#clock().clearTimeout(timer);
    this.#operationRetryTimers.delete(operationId);
  }

  #clearUpdateAssemblies(): void {
    for (const timer of this.#updateAssemblyTimers.values()) this.#clock().clearTimeout(timer);
    this.#updateAssemblyTimers.clear();
    this.#updateAssembler.clear();
  }

  #clearUpdateAssemblyTimer(key: string): void {
    const timer = this.#updateAssemblyTimers.get(key);
    if (timer === undefined) return;
    this.#clock().clearTimeout(timer);
    this.#updateAssemblyTimers.delete(key);
  }

  #clearReconnect(): void {
    if (this.#reconnectTimer === undefined) return;
    this.#clock().clearTimeout(this.#reconnectTimer);
    this.#reconnectTimer = undefined;
  }

  #clearHeartbeat(): void {
    if (this.#heartbeatTimer === undefined) return;
    this.#clock().clearTimeout(this.#heartbeatTimer);
    this.#heartbeatTimer = undefined;
  }

  #clock(): NonNullable<ChalkWhiteboardV1ClientOptions["clock"]> {
    return (
      this.#options.clock ?? {
        now: Date.now,
        setTimeout: (callback, milliseconds) => globalThis.setTimeout(callback, milliseconds),
        clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
      }
    );
  }

  #now(): number {
    return this.#clock().now();
  }
}

function assertConsistentSnapshotPage(assembly: SnapshotAssembly, frame: SnapshotPageFrame): void {
  const coordinates = [
    [assembly.sceneId, frame.scene_id],
    [assembly.revision, frame.revision],
    [assembly.pageCount, frame.page_count],
  ] as const;
  const changedCoordinate = coordinates.some(([current, incoming]) => current !== undefined && current !== incoming);
  if (changedCoordinate || assembly.pages.has(frame.page)) {
    throw new Error("inconsistent whiteboard snapshot page");
  }
}

function assembleSnapshotElements(assembly: SnapshotAssembly, pageCount: number): readonly ChalkWhiteboardV1Element[] {
  const elements: ChalkWhiteboardV1Element[] = [];
  for (let pageNumber = 0; pageNumber < pageCount; pageNumber += 1) {
    const page = assembly.pages.get(pageNumber);
    if (!page) throw new Error("invalid whiteboard snapshot assembly");
    elements.push(...page);
  }
  if (elements.length > WhiteboardV1ProtocolLimits.sceneElementMaxItems) {
    throw new Error("invalid whiteboard snapshot assembly");
  }
  return elements;
}

function elementToFrame(element: ChalkWhiteboardV1Element): WhiteboardV1Element {
  return {
    id: element.id,
    type: element.type,
    version: element.version,
    version_nonce: element.versionNonce,
    index: element.index,
    is_deleted: element.isDeleted,
    payload: element.payload,
  };
}

function elementFromFrame(element: WhiteboardV1Element): ChalkWhiteboardV1Element {
  return {
    id: element.id,
    type: element.type,
    version: element.version,
    versionNonce: element.version_nonce,
    index: element.index,
    isDeleted: element.is_deleted,
    payload: element.payload,
  };
}

function operationName(frame: Extract<WhiteboardV1ClientFrame, { readonly type: "submit_update" | "clear" | "set_draw_permission" | "set_presentation" }>): ChalkWhiteboardV1Operation {
  return frame.type;
}

function retryableOperationCode(code: Extract<WhiteboardV1ServerFrame, { readonly type: "operation_error" }>["code"]): boolean {
  return code === "unavailable" || code === "overloaded" || code === "rate_limited" || code === "storage_unavailable";
}

function terminalCloseCode(closeCode: number): boolean {
  return closeCode === 1008 || closeCode === 1009;
}

function mapErrorCode(code: Extract<WhiteboardV1ServerFrame, { readonly type: "operation_error" }>["code"]): ChalkWhiteboardV1Failure["code"] {
  return code === "overloaded" || code === "rate_limited" ? "unavailable" : code;
}

function failure(operation: ChalkWhiteboardV1Operation, code: ChalkWhiteboardV1Failure["code"], recoverable: boolean, message: string): ChalkWhiteboardV1Failure {
  return { operation, code, recoverable, message };
}

function error(value: ChalkWhiteboardV1Failure, cause?: unknown): ChalkWhiteboardV1Error {
  return new ChalkWhiteboardV1Error(value, cause === undefined ? undefined : { cause });
}

function resolveDeferred<T>(deferred: Deferred<T>, value: T): void {
  if (deferred.settled) return;
  deferred.settled = true;
  deferred.resolve(value);
}

function rejectDeferred<T>(deferred: Deferred<T>, value: Error): void {
  if (deferred.settled) return;
  deferred.settled = true;
  deferred.reject(value);
}

function assertWhiteboardV1Url(url: string): void {
  const parsed = new URL(url);
  if ((parsed.protocol !== "ws:" && parsed.protocol !== "wss:") || parsed.pathname !== "/v1/whiteboard") {
    throw new TypeError("whiteboard-v1 URL must use ws(s) and the /v1/whiteboard route");
  }
}
