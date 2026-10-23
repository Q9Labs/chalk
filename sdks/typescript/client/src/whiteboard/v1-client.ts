import { scheduleSyncDialDeadline } from "../sync/dial-deadline";
import { WhiteboardV1ProtocolLimits, type WhiteboardV1ClientFrame, type WhiteboardV1Element, type WhiteboardV1ServerFrame } from "../generated/whiteboard-v1";
import type { SyncSocket } from "../sync/types";
import {
  ChalkWhiteboardV1Error,
  type ChalkSharedWhiteboardAppState,
  type ChalkWhiteboardV1Capability,
  type ChalkWhiteboardV1ClientOptions,
  type ChalkWhiteboardV1Commit,
  type ChalkWhiteboardDrawPermission,
  type ChalkWhiteboardDrawPolicy,
  type ChalkWhiteboardV1Element,
  type ChalkWhiteboardV1Event,
  type ChalkWhiteboardV1Failure,
  type ChalkWhiteboardV1Operation,
  type ChalkWhiteboardV1PendingOperation,
  type ChalkWhiteboardSummary,
  type ChalkWhiteboardV1Transport,
  type ChalkWhiteboardV1UpdateInput,
  type ChalkWhiteboardView,
} from "./types";
import { decodeWhiteboardV1ServerFrame, encodeWhiteboardV1ClientFrame } from "./v1-codec";
import { WhiteboardV1UpdateAssembler, whiteboardV1OperationFrames, whiteboardV1PendingOperationBytes } from "./v1-multipart";
import { compareChalkWhiteboardV1PendingOperations, InMemoryChalkWhiteboardV1PendingOperationStore } from "./v1-persistence";

const CLIENT_RESTART_CLOSE_CODE = 4000;
const DEPENDENCY_UNAVAILABLE_CLOSE_CODE = 1012;
const HEARTBEAT_INTERVAL_MS = 4_000;
const SLOW_HEARTBEAT_MS = 2_000;
const MAX_SLOW_HEARTBEATS = 2;
const MAX_TIMER_DRIFT_MS = 250;
const MAX_SLOW_CONNECTION_BACKOFF_MS = 4_000;
const DEFAULT_RECONNECT_DELAY_MS = 250;
const MAX_RECONNECT_DELAY_MS = 5_000;
/** Matches the retries the hello ladder used to give a rejected token, so a key rotation or clock skew still clears up. */
const MAX_REJECTED_HELLO_RETRIES = 4;
type ClientPhase = "idle" | "connecting" | "authenticating" | "live" | "stopped";
type CloseStep = "step-down" | "retry-hello" | "reconnect" | "fail";
/**
 * What a close before welcome means. Every Sync closes with 1009 on a hello it can't decode, such as one with an
 * unknown extension, so only that steps the hello down. A 1008 rejects the token or the participant, or says the
 * hello came too late, and any of those can clear up on the next try. Other closes reconnect, or fail when terminal.
 */
const CLOSE_STEPS: Readonly<Partial<Record<number, Partial<Record<ClientPhase, CloseStep>>>>> = {
  1008: { connecting: "retry-hello", authenticating: "retry-hello" },
  1009: { authenticating: "step-down" },
};
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
  readonly promise: Promise<void>;
  readonly requestId: string;
  readonly deferred: Deferred<void>;
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
  readonly #latestViews = new Map<string, Extract<ChalkWhiteboardV1Event, { readonly type: "view" }>>();
  readonly #summaryListeners = new Set<(summary: ChalkWhiteboardSummary) => void>();
  readonly #operations = new Map<string, OperationEntry>();
  /** Strictly increasing, so a restore replays operations made in the same millisecond in the order they were made. */
  #lastCreatedAt = 0;
  readonly #reservedOperationIds = new Set<string>();
  /** Access changes still being saved, by createdAt, so a later change whose save finishes first still waits its turn. */
  readonly #savingAccessChanges = new Map<string, number>();
  /** The access change sent on this connection whose receipt or final failure hasn't arrived. Only its retry timer sends it again. */
  #sentAccessChange: string | null = null;
  readonly #awaitingOperationIds = new Set<string>();
  readonly #pendingStoreWrites = new Set<Promise<void>>();
  readonly #operationRetryTimers = new Map<string, unknown>();
  readonly #snapshots = new Map<string, SnapshotAssembly>();
  readonly #updateAssembler = new WhiteboardV1UpdateAssembler();
  readonly #updateAssemblyTimers = new Map<string, unknown>();
  #socket: SyncSocket | null = null;
  #cancelDial: (() => void) | undefined;
  #started = false;
  #startupGeneration = 0;
  #phase: ClientPhase = "idle";
  #participantId: string | null = null;
  #sceneId: string | null;
  #revision: string | null;
  #capabilities: readonly ChalkWhiteboardV1Capability[] = [];
  #canDraw = false;
  #drawPolicy: ChalkWhiteboardDrawPolicy | null = null;
  #drawPermissions: readonly ChalkWhiteboardDrawPermission[] = [];
  #presentationSupported = false;
  #viewsSupported = false;
  #presenting = false;
  #hello: HelloLevel = "draw-policy";
  #viewSequence = 0;
  readonly #viewEpoch = crypto.randomUUID();
  #pendingBring: { readonly sceneId: string | null; readonly view: ChalkWhiteboardView } | null = null;
  #summaryStatus: ChalkWhiteboardSummary["status"] = "unsubscribed";
  #summaryError: ChalkWhiteboardV1Failure | null = null;
  #latestSnapshot: Extract<ChalkWhiteboardV1Event, { readonly type: "snapshot" }> | null = null;
  #initialSnapshot: Deferred<void> | null = null;
  #startPromise: Promise<void> | null = null;
  #stopPromise: Promise<void> | null = null;
  #waitingForOperations = false;
  #reconnectTimer: unknown;
  #reconnectAttempt = 0;
  #rejectedHelloRetries = 0;
  #heartbeatTimer: unknown;
  readonly #heartbeats: { readonly sentAt: number; slow: boolean }[] = [];
  #ignoredHeartbeats = 0;
  #slowHeartbeats = 0;
  #nextSlowConnectionReplacementAt = 0;
  #heartbeatDueAt = 0;
  #lastProgressAt = Number.NEGATIVE_INFINITY;
  #slowConnectionBackoffMs = 0;
  #healthySince: number | null = null;
  readonly #roundTrips: number[] = [];
  #resumedAt = Number.NEGATIVE_INFINITY;
  readonly #visibilityChanged = () => {
    this.#resumedAt = this.#elapsedNow();
    this.#resetProbeState();
  };
  #lastCursorAt = Number.NEGATIVE_INFINITY;
  #unsubscribeLifecycle: (() => void) | undefined;
  #transportAvailable = true;
  #online = true;
  #active = true;
  #inbound = Promise.resolve();

  constructor(options: ChalkWhiteboardV1ClientOptions) {
    assertWhiteboardV1Url(options.url);
    if (options.clock && typeof options.clock.monotonicNow !== "function") {
      throw new TypeError("whiteboard clock.monotonicNow must use the same timeline as clock.setTimeout");
    }
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
    globalThis.document?.addEventListener("visibilitychange", this.#visibilityChanged);
    this.#hello = "draw-policy";
    this.#rejectedHelloRetries = 0;
    this.#viewsSupported = false;
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
    this.#viewsSupported = false;
    this.#pendingBring = null;
    this.#latestViews.clear();
    this.#removeVisibilityListener();
    this.#startupGeneration += 1;
    this.#unsubscribeLifecycle?.();
    this.#unsubscribeLifecycle = undefined;
    this.#clearReconnect();
    this.#clearDial();
    this.#clearHeartbeat();
    this.#clearOperationRetryTimers();
    this.#clearUpdateAssemblies();
    this.#awaitingOperationIds.clear();
    this.#sentAccessChange = null;
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
    this.#drawPolicy = null;
    this.#drawPermissions = [];
    this.#presenting = false;
    this.#publishSummary("unsubscribed", null);
  }

  subscribe(listener: (event: ChalkWhiteboardV1Event) => void): () => void {
    this.#listeners.add(listener);
    if (this.#phase !== "live") return () => this.#listeners.delete(listener);
    const currentSnapshot = this.#currentSnapshot();
    if (currentSnapshot) listener(currentSnapshot);
    for (const view of this.#latestViews.values()) listener({ ...view, bring: false });
    if (!currentSnapshot && this.#snapshots.size === 0 && !this.#waitingForOperations) void this.#requestSnapshot().catch(() => undefined);
    return () => this.#listeners.delete(listener);
  }

  #currentSnapshot() {
    const snapshot = this.#latestSnapshot;
    if (snapshot?.sceneId !== this.#sceneId) return null;
    if (snapshot?.revision !== this.#revision) return null;
    return snapshot;
  }

  subscribeSummary(listener: (summary: ChalkWhiteboardSummary) => void): () => void {
    this.#summaryListeners.add(listener);
    this.#notifySummaryListener(listener, this.#summary());
    return () => this.#summaryListeners.delete(listener);
  }

  submitUpdate(input: ChalkWhiteboardV1UpdateInput): Promise<ChalkWhiteboardV1Commit> {
    if (!this.#started || !this.#sceneId) this.#assertLive("submit_update");
    if (!this.#canDraw) {
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
    if (!this.#presenceReady || !this.#canDraw) return;
    const now = this.#now();
    if (now - this.#lastCursorAt < 1000 / WhiteboardV1ProtocolLimits.cursorRatePerSecond) return;
    const frame = { type: "cursor", x: input.x, y: input.y } as const;
    encodeWhiteboardV1ClientFrame(frame);
    this.#lastCursorAt = now;
    this.#send(frame);
  }

  get supportsViews(): boolean {
    return this.#started && this.#viewsSupported && this.#viewExtensionEnabled;
  }

  get #viewExtensionEnabled(): boolean {
    return viewsNegotiated(this.#hello);
  }

  get #presenceReady(): boolean {
    return this.#phase === "live" && this.#summaryStatus === "ready" && this.#snapshots.size === 0;
  }

  sendView(view: ChalkWhiteboardView): boolean {
    if (!this.#started || !this.#viewExtensionEnabled) return false;
    const frame = this.#viewFrame(view);
    encodeWhiteboardV1ClientFrame(frame);
    if (!this.#presenceReady) {
      if (view.bring) this.#pendingBring = { sceneId: this.#sceneId, view: { ...view } };
      return true;
    }
    if (view.bring) this.#pendingBring = null;
    this.#send(frame);
    return true;
  }

  #viewFrame(view: ChalkWhiteboardView): Extract<WhiteboardV1ClientFrame, { readonly type: "view" }> {
    const rectangle = { type: "view", x: view.x, y: view.y, width: view.width, height: view.height, bring: view.bring } as const;
    if (view.bring || !viewOriginsNegotiated(this.#hello)) return rectangle;
    if (view.originParticipantId !== undefined) return { ...rectangle, origin_participant_id: view.originParticipantId, origin_sequence: view.originSequence, ...(view.originEpoch !== undefined ? { origin_epoch: view.originEpoch } : {}) };
    if (!this.#participantId) return rectangle;
    return { ...rectangle, origin_participant_id: this.#participantId, origin_sequence: ++this.#viewSequence, origin_epoch: this.#viewEpoch };
  }

  #flushPendingBring(): void {
    if (!this.#presenceReady) return;
    const pending = this.#pendingBring;
    this.#pendingBring = null;
    if (pending && (pending.sceneId === null || pending.sceneId === this.#sceneId)) this.sendView(pending.view);
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

  async setDrawPolicy(policy: ChalkWhiteboardDrawPolicy): Promise<void> {
    this.#assertLive("set_draw_policy");
    if (this.#drawPolicy === null) {
      throw error(policyUnavailable());
    }
    if (!this.#capabilities.includes("manageWhiteboard")) {
      throw error(failure("set_draw_policy", "permission_denied", false, "Whiteboard management permission is required."));
    }
    await this.#queueOperation({ type: "set_draw_policy", operation_id: this.#nextId(), policy });
  }

  async setPresentation(presenting: boolean): Promise<void> {
    this.#assertLive("set_presentation");
    if (!this.#presentationSupported) {
      throw error(failure("set_presentation", "unavailable", true, "Whiteboard presentation is unavailable on this Sync server."));
    }
    if (!this.#canDraw) {
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
      this.#lastCreatedAt = Math.max(this.#lastCreatedAt, pending.createdAt);
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
    this.#removeVisibilityListener();
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
    this.#cancelDial = scheduleSyncDialDeadline(
      this.#clock(),
      () => {
        this.#cancelDial = undefined;
        socket.close(CLIENT_RESTART_CLOSE_CODE, "WebSocket dial timeout");
        this.#disconnected(socket, CLIENT_RESTART_CLOSE_CODE);
        this.#publishSummary("recovering", failure("start_scene_subscription", "unavailable", true, "The board connection timed out before opening."));
      },
      this.#options.dialTimeoutMs,
    );
    socket.onopen = () => {
      if (socket !== this.#socket) return;
      this.#clearDial();
      void this.#authenticate(socket);
    };
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
      this.#presentationSupported = false;
      const cursor = this.#sceneId && this.#revision ? { scene_id: this.#sceneId, revision: this.#revision } : null;
      this.#send(helloFrame(this.#hello, token, cursor));
    } catch {
      socket.close(CLIENT_RESTART_CLOSE_CODE, "whiteboard authentication failed");
    }
  }

  async #receive(socket: SyncSocket, data: unknown): Promise<void> {
    if (socket !== this.#socket) return;
    try {
      if (typeof data !== "string" || encoder.encode(data).byteLength > WhiteboardV1ProtocolLimits.encodedOutboundFrameBytes) {
        throw new Error("invalid whiteboard frame size");
      }
      const frame = decodeWhiteboardV1ServerFrame(data);
      if (frame.type !== "pong") {
        this.#lastProgressAt = this.#elapsedNow();
        this.#resetProbeState();
      }
      this.#handleFrame(frame);
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
      case "view": {
        this.#requireLive();
        const event = {
          type: "view" as const,
          participantId: frame.participant_id,
          displayName: frame.display_name,
          x: frame.x,
          y: frame.y,
          width: frame.width,
          height: frame.height,
          bring: frame.bring,
          occurredAt: frame.occurred_at,
        };
        this.#emit(frame.origin_participant_id ? { ...event, originParticipantId: frame.origin_participant_id, originSequence: frame.origin_sequence, ...(frame.origin_epoch ? { originEpoch: frame.origin_epoch } : {}) } : event);
        return;
      }
      case "permission_updated":
        this.#requireLive();
        if (frame.participant_id === this.#participantId) this.#canDraw = frame.can_draw;
        this.#publishSummary("ready", null);
        return;
      case "draw_access":
        this.#requireLive();
        this.#canDraw = frame.can_draw;
        this.#capabilities = [...frame.capabilities];
        this.#drawPolicy = frame.policy;
        this.#drawPermissions = frame.grants.map((grant) => ({ participantId: grant.participant_id, canDraw: grant.can_draw }));
        this.#publishSummary(this.#summaryStatus, this.#summaryError);
        return;
      case "presentation_updated":
        this.#requireLive();
        if (this.#sceneId !== frame.scene_id) this.#latestViews.clear();
        this.#sceneId = frame.scene_id;
        this.#revision = frame.revision;
        this.#presenting = frame.presenting;
        this.#publishSummary("ready", null);
        return;
      case "reset_required":
        this.#requireLive();
        if (this.#sceneId !== frame.scene_id) this.#latestViews.clear();
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
        this.#receivePong();
        return;
    }
  }

  #update(frame: Extract<WhiteboardV1ServerFrame, { readonly type: "update" }>): void {
    this.#requireLive();
    if (this.#sceneId !== frame.scene_id) this.#latestViews.clear();
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
    this.#viewsSupported = viewsNegotiated(this.#hello);
    this.#reconnectAttempt = 0;
    this.#rejectedHelloRetries = 0;
    this.#participantId = frame.participant_id;
    if (this.#sceneId !== frame.scene_id) this.#latestViews.clear();
    this.#sceneId = frame.scene_id;
    this.#revision = frame.revision;
    this.#capabilities = [...frame.capabilities];
    this.#canDraw = frame.can_draw;
    // Sync sends draw_access right after welcome when it accepted draw_policy_v1.
    this.#drawPolicy = null;
    this.#drawPermissions = [];
    this.#presentationSupported = "presenting" in frame;
    this.#presenting = "presenting" in frame ? frame.presenting : false;
    // A change restored from the store has no caller to reject, so the summary carries the refusal too.
    const refused = this.#hello !== "draw-policy" && this.#dropPolicyChanges();
    this.#publishSummary("loading", refused ? policyUnavailable() : null);
    this.#clearHeartbeat();
    const pendingOperations = [...this.#operations.values()].sort((left, right) => compareChalkWhiteboardV1PendingOperations(left.pending, right.pending));
    this.#awaitingOperationIds.clear();
    this.#sentAccessChange = null;
    this.#waitingForOperations = true;
    const sendable = pendingOperations.filter((entry) => this.#sendable(entry.pending.frame));
    for (const entry of sendable) this.#awaitingOperationIds.add(entry.pending.operationId);
    for (const entry of sendable) {
      this.#sendOperation(entry.pending.frame);
    }
    this.#requestSnapshotAfterOperations();
    this.#startHeartbeat(HEARTBEAT_INTERVAL_MS + Math.max(0, this.#nextSlowConnectionReplacementAt - this.#elapsedNow()));
  }

  /** A Sync without draw_policy_v1 closes the socket on a policy change, so a change saved for a newer Sync is dropped, not replayed. */
  #dropPolicyChanges(): boolean {
    let dropped = false;
    for (const [operationId, entry] of this.#operations) {
      if (entry.pending.frame.type !== "set_draw_policy") continue;
      dropped = true;
      this.#operations.delete(operationId);
      this.#clearOperationRetryTimer(operationId);
      entry.deferred && rejectDeferred(entry.deferred, error(policyUnavailable()));
      void this.#store.remove(operationId).catch(() => undefined);
    }
    return dropped;
  }

  #requestSnapshotAfterOperations(): void {
    if (this.#phase !== "live" || !this.#waitingForOperations || this.#awaitingOperationIds.size > 0) return;
    this.#waitingForOperations = false;
    void this.#requestSnapshot().catch(() => undefined);
  }

  #requestSnapshot(): Promise<void> {
    const active = this.#snapshots.values().next().value;
    if (active) return active.promise;
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
    if (this.#sceneId !== frame.scene_id) this.#latestViews.clear();
    this.#sceneId = frame.scene_id;
    this.#revision = frame.revision;
    this.#publishSummary("ready", null);
    // Operations persisted while snapshot pages were in flight are sent only
    // after the final acknowledgement restores the server's live phase.
    this.#flushQueuedOperations();
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
  }

  async #queueOperation(frame: Extract<WhiteboardV1ClientFrame, { readonly type: "submit_update" | "clear" | "set_draw_permission" | "set_draw_policy" | "set_presentation" }>): Promise<ChalkWhiteboardV1Commit> {
    this.#assertOperationCapacity();
    whiteboardV1OperationFrames(frame);
    const pending = {
      operationId: frame.operation_id,
      frame,
      createdAt: (this.#lastCreatedAt = Math.max(this.#now(), this.#lastCreatedAt + 1)),
      bytes: whiteboardV1PendingOperationBytes(frame),
    } satisfies ChalkWhiteboardV1PendingOperation;
    const queuedBytes = [...this.#operations.values()].reduce((total, entry) => total + entry.pending.bytes, 0);
    if (queuedBytes + pending.bytes > WhiteboardV1ProtocolLimits.multipartUpdateMaxBytes) {
      throw error(failure("submit_update", "unavailable", true, "Whiteboard operation byte capacity is full."));
    }
    await this.#persist(pending);
    if (frame.type === "set_draw_policy" && this.#phase === "live" && this.#hello !== "draw-policy") {
      void this.#store.remove(frame.operation_id).catch(() => undefined);
      this.#sendNextAccessChange();
      throw error(policyUnavailable());
    }
    let deferred!: Deferred<ChalkWhiteboardV1Commit>;
    const promise = new Promise<ChalkWhiteboardV1Commit>((resolve, reject) => {
      deferred = { resolve, reject, settled: false };
    });
    this.#operations.set(frame.operation_id, { pending, deferred, retries: 0 });
    if (this.#phase === "live" && this.#snapshots.size === 0 && this.#sendable(frame)) {
      if (this.#waitingForOperations) this.#awaitingOperationIds.add(frame.operation_id);
      this.#sendOperation(frame);
    }
    return promise;
  }

  async #persist(pending: ChalkWhiteboardV1PendingOperation): Promise<void> {
    const { operationId, frame } = pending;
    this.#reservedOperationIds.add(operationId);
    if (isAccessChange(frame)) this.#savingAccessChanges.set(operationId, pending.createdAt);
    let storeWrite: Promise<void> | undefined;
    try {
      storeWrite = this.#store.put(pending);
      this.#pendingStoreWrites.add(storeWrite);
      await storeWrite;
    } catch (cause) {
      this.#reservedOperationIds.delete(operationId);
      this.#abandonAccessChange(operationId);
      throw error(failure(operationName(frame), "unavailable", true, "Unable to persist the whiteboard operation."), cause);
    } finally {
      if (storeWrite) this.#pendingStoreWrites.delete(storeWrite);
      this.#reservedOperationIds.delete(operationId);
      this.#savingAccessChanges.delete(operationId);
    }
  }

  #commit(frame: Extract<WhiteboardV1ServerFrame, { readonly type: "commit" }>): void {
    this.#requireLive();
    const entry = this.#operations.get(frame.operation_id);
    if (!entry) return;
    this.#operations.delete(frame.operation_id);
    this.#clearOperationRetryTimer(frame.operation_id);
    if (this.#sceneId !== frame.scene_id) this.#latestViews.clear();
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
    this.#accessChangeDecided(frame.operation_id);
    this.#requestSnapshotAfterOperations();
  }

  #operationError(frame: Extract<WhiteboardV1ServerFrame, { readonly type: "operation_error" }>): void {
    this.#requireLive();
    const entry = this.#operations.get(frame.correlation_id);
    if (entry) {
      this.#failOperation(entry, frame);
      return;
    }
    const snapshot = this.#snapshots.get(frame.correlation_id);
    if (snapshot) this.#failSnapshot(snapshot, frame);
  }

  #failOperation(entry: OperationEntry, frame: Extract<WhiteboardV1ServerFrame, { readonly type: "operation_error" }>): void {
    if (frame.recoverable && retryableOperationCode(frame.code)) {
      this.#scheduleOperationRetry(frame.correlation_id, entry);
      return;
    }
    this.#operations.delete(frame.correlation_id);
    this.#clearOperationRetryTimer(frame.correlation_id);
    this.#awaitingOperationIds.delete(frame.correlation_id);
    const operationFailure = failure(operationName(entry.pending.frame), mapErrorCode(frame.code), frame.recoverable, frame.message);
    entry.deferred && rejectDeferred(entry.deferred, error(operationFailure));
    this.#publishSummary("ready", operationFailure);
    void this.#store.remove(frame.correlation_id).catch(() => undefined);
    this.#accessChangeDecided(frame.correlation_id);
    this.#requestSnapshotAfterOperations();
  }

  #failSnapshot(snapshot: SnapshotAssembly, frame: Extract<WhiteboardV1ServerFrame, { readonly type: "operation_error" }>): void {
    this.#snapshots.delete(frame.correlation_id);
    const snapshotError = error(failure("request_snapshot", mapErrorCode(frame.code), frame.recoverable, frame.message));
    this.#publishSummary(frame.recoverable ? "recovering" : "failed", failure("request_snapshot", mapErrorCode(frame.code), frame.recoverable, frame.message));
    rejectDeferred(snapshot.deferred, snapshotError);
    if (this.#initialSnapshot) {
      rejectDeferred(this.#initialSnapshot, snapshotError);
      this.#initialSnapshot = null;
    }
    if (frame.recoverable) this.#flushQueuedOperations();
    else this.#sendNextAccessChange();
  }

  #flushQueuedOperations(): void {
    if (this.#phase !== "live" || this.#snapshots.size > 0) return;
    for (const entry of this.#operations.values()) {
      if (!this.#awaitingOperationIds.has(entry.pending.operationId) && this.#sendable(entry.pending.frame)) this.#sendOperation(entry.pending.frame);
    }
  }

  /**
   * Access changes go out one at a time in the host's order, so a retried older change can't land after a newer one.
   * Sync also stores a per-person choice according to the policy it lands under, so their order matters too.
   */
  #sendable(frame: ChalkWhiteboardV1PendingOperation["frame"]): boolean {
    return !isAccessChange(frame) || (this.#sentAccessChange === null && this.#nextAccessChangeId() === frame.operation_id);
  }

  #sendNextAccessChange(): void {
    if (this.#phase !== "live" || this.#snapshots.size > 0 || this.#sentAccessChange !== null) return;
    const nextId = this.#nextAccessChangeId();
    const next = nextId === undefined ? undefined : this.#operations.get(nextId);
    if (!next) return;
    if (this.#waitingForOperations) this.#awaitingOperationIds.add(next.pending.operationId);
    this.#sendOperation(next.pending.frame);
  }

  /** The oldest access change, counting ones still being saved. */
  #nextAccessChangeId(): string | undefined {
    let next: { readonly id: string; readonly createdAt: number } | undefined;
    const consider = (id: string, createdAt: number) => {
      if (!next || createdAt < next.createdAt || (createdAt === next.createdAt && id.localeCompare(next.id) < 0)) next = { id, createdAt };
    };
    for (const entry of this.#operations.values()) if (isAccessChange(entry.pending.frame)) consider(entry.pending.operationId, entry.pending.createdAt);
    for (const [id, createdAt] of this.#savingAccessChanges) consider(id, createdAt);
    return next?.id;
  }

  /** A receipt or a final failure decides an access change, so the next one can go. */
  #accessChangeDecided(operationId: string): void {
    if (this.#sentAccessChange !== operationId) return;
    this.#sentAccessChange = null;
    this.#sendNextAccessChange();
  }

  #abandonAccessChange(operationId: string): void {
    if (this.#savingAccessChanges.delete(operationId)) this.#sendNextAccessChange();
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
    const phase = this.#phase;
    this.#resetDisconnectedState();
    if (!this.#started || !this.#transportAvailable) return;
    const step = CLOSE_STEPS[closeCode]?.[phase] ?? (terminalCloseCode(closeCode) ? "fail" : "reconnect");
    if (this.#takeCloseStep(step, phase)) this.#scheduleReconnect();
    else this.#failRejectedConnection(closeCode);
  }

  /** Returns false when the step has nothing left to try, so the connection fails. */
  #takeCloseStep(step: CloseStep, phase: ClientPhase): boolean {
    if (step === "fail") return false;
    if (step === "step-down") return this.#stepDownHello();
    if (step === "retry-hello") return this.#retryHello();
    if (phase === "live") this.#hello = "draw-policy";
    return true;
  }

  #stepDownHello(): boolean {
    if (this.#hello === "legacy") return false;
    this.#fallbackHello();
    return true;
  }

  #retryHello(): boolean {
    if (this.#rejectedHelloRetries >= MAX_REJECTED_HELLO_RETRIES) return false;
    this.#rejectedHelloRetries += 1;
    return true;
  }

  #fallbackHello(): void {
    this.#hello = HELLO_LEVELS[Math.min(HELLO_LEVELS.indexOf(this.#hello) + 1, HELLO_LEVELS.length - 1)] ?? "legacy";
    if (!viewsNegotiated(this.#hello)) this.#pendingBring = null;
  }

  #resetDisconnectedState(): void {
    this.#socket = null;
    this.#clearDial();
    this.#clearHeartbeat();
    this.#clearUpdateAssemblies();
    this.#phase = "connecting";
    this.#waitingForOperations = false;
    this.#participantId = null;
    this.#rejectSnapshots(failure("request_snapshot", "unavailable", true, "Whiteboard connection interrupted."));
    this.#publishSummary("recovering", failure("start_scene_subscription", "unavailable", true, "Whiteboard connection interrupted."));
  }

  #failRejectedConnection(closeCode: number): void {
    this.#removeVisibilityListener();
    const terminalFailure = failure("start_scene_subscription", closeCode === 1008 ? "permission_denied" : "invalid_payload", false, "Whiteboard connection was rejected.");
    this.#started = false;
    this.#publishSummary("failed", terminalFailure);
    if (this.#initialSnapshot) rejectDeferred(this.#initialSnapshot, error(terminalFailure));
    this.#rejectOperationCallers(terminalFailure);
  }

  #clearDial(): void {
    this.#cancelDial?.();
    this.#cancelDial = undefined;
  }

  #scheduleReconnect(): void {
    this.#clearReconnect();
    const configuredDelay = this.#options.reconnectDelayMs;
    const delay = configuredDelay === 0 ? 0 : Math.min(MAX_RECONNECT_DELAY_MS, (configuredDelay ?? DEFAULT_RECONNECT_DELAY_MS) * 2 ** Math.min(this.#reconnectAttempt, 5));
    this.#reconnectAttempt += 1;
    this.#reconnectTimer = this.#clock().setTimeout(() => {
      this.#reconnectTimer = undefined;
      this.#connect();
    }, delay);
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
    this.#socket?.send(encodeWhiteboardV1ClientFrame(frame));
  }

  #sendOperation(frame: ChalkWhiteboardV1PendingOperation["frame"]): void {
    if (isAccessChange(frame)) this.#sentAccessChange = frame.operation_id;
    for (const outbound of whiteboardV1OperationFrames(frame)) this.#send(outbound);
  }

  #emit(event: ChalkWhiteboardV1Event): void {
    if (event.type === "snapshot") this.#latestSnapshot = event;
    if (event.type === "view") {
      this.#latestViews.delete(event.participantId);
      this.#latestViews.set(event.participantId, event);
      if (this.#latestViews.size > 256) {
        const oldest = this.#latestViews.keys().next().value;
        if (oldest !== undefined) this.#latestViews.delete(oldest);
      }
    }
    for (const listener of this.#listeners) listener(event);
  }

  #publishSummary(status: ChalkWhiteboardSummary["status"], summaryError: ChalkWhiteboardV1Failure | null): void {
    this.#summaryStatus = status;
    this.#summaryError = summaryError;
    if (status === "failed") this.#pendingBring = null;
    if (status === "ready") this.#flushPendingBring();
    const summary = this.#summary();
    try {
      this.#options.onSummary?.(summary);
    } catch {
      // Consumer summary callbacks cannot interfere with transport ownership.
    }
    for (const listener of this.#summaryListeners) this.#notifySummaryListener(listener, summary);
  }

  #summary(): ChalkWhiteboardSummary {
    return {
      status: this.#summaryStatus,
      sceneId: this.#sceneId,
      revision: this.#revision,
      capabilities: [...this.#capabilities],
      canDraw: this.#canDraw,
      canClear: this.#capabilities.includes("manageWhiteboard"),
      drawPolicy: this.#drawPolicy,
      drawPermissions: this.#drawPermissions,
      presenting: this.#presenting,
      error: this.#summaryError,
    };
  }

  #notifySummaryListener(listener: (summary: ChalkWhiteboardSummary) => void, summary: ChalkWhiteboardSummary): void {
    try {
      listener(summary);
    } catch {
      // Consumer summary callbacks cannot interfere with transport ownership.
    }
  }

  #startHeartbeat(delay = HEARTBEAT_INTERVAL_MS): void {
    this.#heartbeatDueAt = this.#elapsedNow() + delay;
    this.#heartbeatTimer = this.#clock().setTimeout(() => {
      this.#heartbeatTimer = undefined;
      if (this.#phase !== "live") return;
      const now = this.#elapsedNow();
      const qualified = this.#qualifyProbe(now);
      if (qualified && this.#checkSlowHeartbeats(now)) return;
      if (qualified) this.#heartbeats.push({ sentAt: now, slow: false });
      else this.#ignoredHeartbeats += 1;
      this.#send({ type: "ping" });
      const outstanding = this.#heartbeats.length > 0;
      this.#startHeartbeat(this.#options.watchdog !== false && outstanding ? SLOW_HEARTBEAT_MS : HEARTBEAT_INTERVAL_MS);
    }, delay);
  }

  #checkSlowHeartbeats(now: number): boolean {
    for (const heartbeat of this.#heartbeats) {
      if (!heartbeat.slow && now - heartbeat.sentAt >= SLOW_HEARTBEAT_MS) {
        heartbeat.slow = true;
        this.#healthySince = null;
        this.#slowHeartbeats += 1;
      }
    }
    return this.#replaceSlowConnection();
  }

  #resetProbeState(): void {
    this.#ignoredHeartbeats += this.#heartbeats.length;
    this.#heartbeats.length = 0;
    this.#slowHeartbeats = 0;
    this.#roundTrips.length = 0;
    this.#healthySince = null;
  }

  #qualifyProbe(now: number): boolean {
    if (this.#options.watchdog === false || globalThis.document?.hidden || now - this.#resumedAt < HEARTBEAT_INTERVAL_MS || now - this.#heartbeatDueAt > MAX_TIMER_DRIFT_MS || now - this.#lastProgressAt < SLOW_HEARTBEAT_MS) {
      this.#resetProbeState();
      return false;
    }
    return true;
  }

  #receivePong(): void {
    // Sync sends exactly one immediate pong per ping; open WebSockets deliver in FIFO order.
    // A missing pong means a broken/stalled path. Even if one were lost on a working
    // path, an extra reconnect/catch-up is acceptable; never match it to a newer ping.
    const now = this.#elapsedNow();
    const qualified = this.#qualifyProbe(now);
    if (this.#ignoredHeartbeats > 0) {
      this.#ignoredHeartbeats -= 1;
      return;
    }
    const heartbeat = this.#heartbeats.shift();
    if (!heartbeat) {
      this.#resetProbeState();
      return;
    }
    if (!qualified) return;
    const roundTrip = now - heartbeat.sentAt;
    this.#roundTrips.push(roundTrip);
    if (this.#roundTrips.length > MAX_SLOW_HEARTBEATS) this.#roundTrips.shift();
    if (roundTrip < SLOW_HEARTBEAT_MS) {
      this.#slowHeartbeats = 0;
      this.#healthySince ??= now;
      if (now - this.#healthySince >= 60_000) this.#slowConnectionBackoffMs = 0;
      this.#clock().clearTimeout(this.#heartbeatTimer);
      this.#startHeartbeat();
    } else {
      this.#healthySince = null;
      if (!heartbeat.slow) this.#slowHeartbeats += 1;
    }
    this.#replaceSlowConnection();
  }

  #replaceSlowConnection(): boolean {
    const now = this.#elapsedNow();
    if (this.#slowHeartbeats < MAX_SLOW_HEARTBEATS || now < this.#nextSlowConnectionReplacementAt) return false;
    const socket = this.#socket;
    if (!socket) return false;
    this.#slowConnectionBackoffMs = Math.min(MAX_SLOW_CONNECTION_BACKOFF_MS, this.#slowConnectionBackoffMs === 0 ? 1_000 : this.#slowConnectionBackoffMs * 2);
    // Delay the next probe cycle, rather than ignoring failures during a flat cooldown.
    this.#nextSlowConnectionReplacementAt = now + this.#slowConnectionBackoffMs;
    const event = { reason: "slow_heartbeat" as const, roundTripsMs: [...this.#roundTrips], outstandingAgesMs: this.#heartbeats.slice(-2).map((heartbeat) => now - heartbeat.sentAt), backoffMs: this.#slowConnectionBackoffMs };
    // Do not wait for a congested socket's closing handshake to reconnect.
    this.#disconnected(socket, DEPENDENCY_UNAVAILABLE_CLOSE_CODE);
    socket.close(CLIENT_RESTART_CLOSE_CODE, "whiteboard connection slow");
    try {
      this.#options.onWatchdogReplacement?.(event);
    } catch {
      // Consumer telemetry callbacks cannot interfere with transport ownership.
    }
    return true;
  }

  #rejectSnapshots(value: ChalkWhiteboardV1Failure): void {
    for (const assembly of this.#snapshots.values()) rejectDeferred(assembly.deferred, error(value));
    this.#snapshots.clear();
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
    this.#heartbeats.length = 0;
    this.#ignoredHeartbeats = 0;
    this.#slowHeartbeats = 0;
    this.#roundTrips.length = 0;
    this.#healthySince = null;
    if (this.#heartbeatTimer === undefined) return;
    this.#clock().clearTimeout(this.#heartbeatTimer);
    this.#heartbeatTimer = undefined;
  }

  #removeVisibilityListener(): void {
    globalThis.document?.removeEventListener("visibilitychange", this.#visibilityChanged);
  }

  #elapsedNow(): number {
    // Wall-clock timestamps remain on #now() for persisted operation ordering.
    return this.#clock().monotonicNow();
  }

  #clock(): NonNullable<ChalkWhiteboardV1ClientOptions["clock"]> {
    return (
      this.#options.clock ?? {
        now: Date.now,
        monotonicNow: () => globalThis.performance.now(),
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

function operationName(frame: Extract<WhiteboardV1ClientFrame, { readonly type: "submit_update" | "clear" | "set_draw_permission" | "set_draw_policy" | "set_presentation" }>): ChalkWhiteboardV1Operation {
  return frame.type;
}

function retryableOperationCode(code: Extract<WhiteboardV1ServerFrame, { readonly type: "operation_error" }>["code"]): boolean {
  return code === "unavailable" || code === "overloaded" || code === "rate_limited" || code === "storage_unavailable";
}

// Older Sync servers close an unknown hello, so the client steps down this list.
const HELLO_LEVELS = ["draw-policy", "versioned-view", "view", "presentation", "legacy"] as const;
type HelloLevel = (typeof HELLO_LEVELS)[number];

function viewsNegotiated(level: HelloLevel): boolean {
  return level === "draw-policy" || level === "versioned-view" || level === "view";
}

function viewOriginsNegotiated(level: HelloLevel): boolean {
  return level === "draw-policy" || level === "versioned-view";
}

function helloFrame(level: HelloLevel, token: string, cursor: { readonly scene_id: string; readonly revision: string } | null): WhiteboardV1ClientFrame {
  const hello = { type: "hello", protocol: "whiteboard-v1", token, cursor } as const;
  if (level === "legacy") return hello;
  if (level === "presentation") return { ...hello, extensions: [{ name: "presentation_v1" }] };
  if (level === "view") return { ...hello, extensions: [{ name: "presentation_v1" }, { name: "view_v1" }] };
  if (level === "versioned-view") return { ...hello, extensions: [{ name: "presentation_v1" }, { name: "view_v1", origins: true }] };
  return { ...hello, extensions: [{ name: "presentation_v1" }, { name: "view_v1", origins: true }, { name: "draw_policy_v1" }] };
}

function policyUnavailable(): ChalkWhiteboardV1Failure {
  return failure("set_draw_policy", "unavailable", true, "The call-wide drawing policy is unavailable on this Sync server.");
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

function isAccessChange(frame: ChalkWhiteboardV1PendingOperation["frame"]): boolean {
  return frame.type === "set_draw_policy" || frame.type === "set_draw_permission";
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
