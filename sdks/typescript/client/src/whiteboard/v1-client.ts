import { WHITEBOARD_PATH } from "../urls";
import { ChalkWhiteboardViewVersions } from "./view-versions";
import { scheduleSyncDialDeadline } from "../sync/dial-deadline";
import { encodedWhiteboardV1FrameBytes, WhiteboardV1ProtocolLimits, type WhiteboardV1ClientFrame, type WhiteboardV1ServerFrame } from "../generated/whiteboard-v1";
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
import { decodeWhiteboardV1WireFrame, elementFromFrame, elementToFrame, encodeWhiteboardV1ClientFrame } from "./v1-codec";
import { BARE_HELLO, FIRST_HELLO, helloFrame, nextHelloLevel, type HelloLevel } from "./v1-hello";
import { WhiteboardV1UpdateAssembler, whiteboardV1OperationFrames, type WhiteboardV1LogicalOperationFrame } from "./v1-multipart";
import { WhiteboardV1Watchdog, type WhiteboardV1WatchdogReplacement } from "./v1-watchdog";
import { compareChalkWhiteboardV1PendingOperations, InMemoryChalkWhiteboardV1PendingOperationStore } from "./v1-persistence";

const CLIENT_RESTART_CLOSE_CODE = 4000;
const DEPENDENCY_UNAVAILABLE_CLOSE_CODE = 1012;
const DEFAULT_RECONNECT_DELAY_MS = 250;
const MAX_RECONNECT_DELAY_MS = 5_000;
function reconnectDelay(configuredDelay: number | undefined, attempt: number, random: () => number): number {
  if (configuredDelay === 0) return 0;
  const base = Math.min(MAX_RECONNECT_DELAY_MS, (configuredDelay ?? DEFAULT_RECONNECT_DELAY_MS) * 2 ** Math.min(attempt, 5));
  return Math.round(base * (0.5 + 0.5 * random()));
}
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
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (error: unknown) => void;
  settled: boolean;
};

type ServerFrameByType = { [Frame in WhiteboardV1ServerFrame as Frame["type"]]: Frame };
type ServerFrame<Type extends keyof ServerFrameByType> = ServerFrameByType[Type];
type FrameHandlers = { readonly [Type in keyof ServerFrameByType]: (frame: ServerFrameByType[Type]) => void };
type ClientFrame<Type extends WhiteboardV1ClientFrame["type"]> = Extract<WhiteboardV1ClientFrame, { readonly type: Type }>;

type OperationEntry = {
  readonly pending: ChalkWhiteboardV1PendingOperation;
  readonly deferred?: Deferred<ChalkWhiteboardV1Commit>;
  retries: number;
};

/**
 * An access change waits in `saving` until the store has it, in `ready` until it is the first change in the list,
 * and in `sent` until its receipt or final failure. A decided change leaves the list, so it has no state of its own.
 */
type AccessChange = { readonly entry: OperationEntry; state: "saving" | "ready" | "sent" };

type SnapshotAssembly = {
  readonly deferred: Deferred<void>;
  sceneId?: string;
  revision?: string;
  pageCount?: number;
  appState?: ChalkSharedWhiteboardAppState;
  readonly pages: Map<number, readonly ChalkWhiteboardV1Element[]>;
};

type SnapshotPageFrame = ServerFrame<"snapshot_page">;

export class ChalkWhiteboardV1Client implements ChalkWhiteboardV1Transport {
  readonly files;
  readonly #options: ChalkWhiteboardV1ClientOptions;
  readonly #store;
  readonly #listeners = new Set<(event: ChalkWhiteboardV1Event) => void>();
  readonly #latestViews = new Map<string, Extract<ChalkWhiteboardV1Event, { readonly type: "view" }>>();
  readonly #summaryListeners = new Set<(summary: ChalkWhiteboardSummary) => void>();
  readonly #operations = new Map<string, OperationEntry>();
  readonly #savingOperations = new Map<string, OperationEntry>();
  /** Strictly increasing, so a restore replays operations made in the same millisecond in the order they were made. */
  #lastCreatedAt = 0;
  /**
   * Policy changes and per-person choices in the order the host made them. Only the first one is sent, and only once it
   * is saved, so the order comes from creation and never from which save finishes first.
   */
  readonly #accessChanges: AccessChange[] = [];
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
  #presenterId: string | null = null;
  #hello: HelloLevel = FIRST_HELLO;
  #viewSequence = 0;
  #viewOwnerId: string | null = null;
  readonly #viewVersions = new ChalkWhiteboardViewVersions();
  readonly #viewEpoch = crypto.randomUUID();
  #pendingLeadingView: { readonly sceneId: string | null; readonly view: ChalkWhiteboardView; readonly frame: ClientFrame<"view"> } | null = null;
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
  readonly #watchdog: WhiteboardV1Watchdog;
  readonly #visibilityChanged = () => this.#watchdog.noteResume();
  #lastCursorAt = Number.NEGATIVE_INFINITY;
  #unsubscribeLifecycle: (() => void) | undefined;
  #transportAvailable = true;
  #online = true;
  #active = true;
  #inbound = Promise.resolve();
  readonly #frameHandlers: FrameHandlers = {
    welcome: (frame) => this.#welcome(frame),
    snapshot_page: (frame) => this.#snapshotPage(frame),
    update: (frame) => this.#update(frame),
    update_part: (frame) => this.#updatePart(frame),
    commit: (frame) => this.#commit(frame),
    cursor: (frame) => this.#cursor(frame),
    view_ack: (frame) => this.#viewAck(frame),
    view: (frame) => this.#view(frame),
    permission_updated: (frame) => this.#permissionUpdated(frame),
    draw_access: (frame) => this.#drawAccess(frame),
    presentation_updated: (frame) => this.#presentationUpdated(frame),
    reset_required: (frame) => this.#resetRequired(frame),
    operation_error: (frame) => this.#operationError(frame),
    pong: () => this.#watchdog.receivePong(),
  };

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
    this.#watchdog = new WhiteboardV1Watchdog({
      clock: () => this.#clock(),
      enabled: options.watchdog !== false,
      isLive: () => this.#phase === "live",
      ping: () => this.#send({ type: "ping" }),
      hasConnection: () => this.#socket !== null,
      replaceConnection: (event) => this.#replaceConnection(event),
    });
  }

  #replaceConnection(event: WhiteboardV1WatchdogReplacement): void {
    const socket = this.#socket;
    if (!socket) return;
    // Do not wait for a congested socket's closing handshake to reconnect.
    this.#disconnected(socket, DEPENDENCY_UNAVAILABLE_CLOSE_CODE);
    socket.close(CLIENT_RESTART_CLOSE_CODE, "whiteboard connection slow");
    try {
      this.#options.onWatchdogReplacement?.(event);
    } catch {
      // Consumer telemetry callbacks cannot interfere with transport ownership.
    }
  }

  startSceneSubscription(): Promise<void> {
    if (this.#stopPromise) return this.#stopPromise.then(() => this.startSceneSubscription());
    if (this.#started && this.#startPromise) return this.#startPromise;
    this.#started = true;
    globalThis.document?.addEventListener("visibilitychange", this.#visibilityChanged);
    this.#hello = FIRST_HELLO;
    this.#rejectedHelloRetries = 0;
    this.#viewsSupported = false;
    this.#phase = "connecting";
    this.#publishSummary("loading", null);
    const generation = ++this.#startupGeneration;
    this.#initialSnapshot = createDeferred<void>();
    this.#startPromise = this.#initialSnapshot.promise;
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
    this.#pendingLeadingView = null;
    this.#latestViews.clear();
    this.#removeVisibilityListener();
    this.#startupGeneration += 1;
    this.#unsubscribeLifecycle?.();
    this.#unsubscribeLifecycle = undefined;
    this.#clearReconnect();
    this.#clearDial();
    this.#watchdog.stop();
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
    this.#drawPolicy = null;
    this.#drawPermissions = [];
    this.#presenting = false;
    this.#presenterId = null;
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
    return this.#started && this.#viewsSupported && this.#hello.views;
  }

  get #presenceReady(): boolean {
    return this.#phase === "live" && this.#summaryStatus === "ready" && this.#snapshots.size === 0;
  }

  forgetParticipant(participantId: string): void {
    this.#latestViews.delete(participantId);
    this.#viewVersions.forgetParticipant(participantId);
  }

  sendView(view: ChalkWhiteboardView): boolean {
    if (!this.#started || !this.#hello.views) return false;
    const frame = this.#viewFrame(view);
    encodeWhiteboardV1ClientFrame(frame);
    if (view.bring || view.lead !== false) this.#pendingLeadingView = { sceneId: this.#sceneId, view: { ...view }, frame };
    if (!this.#presenceReady) return true;
    this.#send(frame);
    if (!this.#viewOwnerId && (view.bring || view.lead !== false)) this.#pendingLeadingView = null;
    return true;
  }

  #viewFrame(view: ChalkWhiteboardView): ClientFrame<"view"> {
    const rectangle = { type: "view", x: view.x, y: view.y, width: view.width, height: view.height, bring: view.bring } as const;
    if (this.#viewOwnerId) {
      const input = { input_id: `${this.#viewEpoch}:${++this.#viewSequence}`, move: view.lead !== false || view.bring };
      return view.originParticipantId ? { ...rectangle, ...input, origin_participant_id: view.originParticipantId, origin_sequence: view.originSequence } : { ...rectangle, ...input };
    }
    if (view.bring || !this.#hello.origins) return rectangle;
    if (view.originParticipantId !== undefined) return { ...rectangle, origin_participant_id: view.originParticipantId, origin_sequence: view.originSequence, ...(view.originEpoch !== undefined ? { origin_epoch: view.originEpoch } : {}) };
    if (!this.#participantId) return rectangle;
    return { ...rectangle, origin_participant_id: this.#participantId, origin_sequence: ++this.#viewSequence, origin_epoch: this.#viewEpoch };
  }

  #flushPendingBring(): void {
    if (!this.#presenceReady) return;
    const pending = this.#pendingLeadingView;
    if (!pending) return;
    if (pending.sceneId !== null && pending.sceneId !== this.#sceneId) {
      this.#pendingLeadingView = null;
      return;
    }
    if (!this.#viewOwnerId) {
      this.#pendingLeadingView = null;
      this.sendView(pending.view);
      return;
    }
    const frame = pending.frame.input_id ? pending.frame : this.#viewFrame(pending.view);
    this.#pendingLeadingView = { ...pending, frame };
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
    await this.#queueOperation({ type: "set_draw_permission", operation_id: this.#nextId(), participant_id: participantId, can_draw: canDraw });
  }

  async setDrawPolicy(policy: ChalkWhiteboardDrawPolicy): Promise<void> {
    this.#assertLive("set_draw_policy");
    if (this.#drawPolicy === null) throw error(policyUnavailable());
    if (!this.#capabilities.includes("manageWhiteboard")) throw error(failure("set_draw_policy", "permission_denied", false, "Whiteboard management permission is required."));
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
    await this.#queueOperation({ type: "set_presentation", operation_id: this.#nextId(), presenting });
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
      if (!isAccessChange(pending.frame) && this.#savingOperations.has(pending.operationId)) continue;
      if (this.#operationCount() >= WhiteboardV1ProtocolLimits.pendingOperationMaxItems) return;
      this.#lastCreatedAt = Math.max(this.#lastCreatedAt, pending.createdAt);
      if (!isAccessChange(pending.frame)) this.#operations.set(pending.operationId, { pending, retries: 0 });
      else if (!this.#accessChange(pending.operationId)) this.#restoreAccessChange(pending);
    }
  }

  #validRestoredOperation(pending: ChalkWhiteboardV1PendingOperation): boolean {
    try {
      whiteboardV1OperationFrames(pending.frame);
      return pending.operationId === pending.frame.operation_id && pending.bytes === encodedWhiteboardV1FrameBytes(pending.frame);
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
      const frame = decodeWhiteboardV1WireFrame(data);
      if (frame.type !== "pong") {
        this.#watchdog.noteProgress();
      }
      this.#handleFrame(frame);
    } catch {
      socket.close(1009, "invalid whiteboard frame");
    }
  }

  #handleFrame(frame: WhiteboardV1ServerFrame): void {
    if (frame.type !== "welcome") this.#requireLive();
    dispatchFrame(this.#frameHandlers, frame.type, frame);
  }

  /** Moves to the scene a frame names, dropping the views of the scene it leaves. */
  #moveToScene(sceneId: string, revision: string | null): void {
    if (this.#sceneId !== sceneId) this.#latestViews.clear();
    this.#sceneId = sceneId;
    this.#revision = revision;
  }

  #cursor(frame: ServerFrame<"cursor">): void {
    this.#emit({ type: "cursor", participantId: frame.participant_id, displayName: frame.display_name, x: frame.x, y: frame.y, occurredAt: frame.occurred_at });
  }

  #viewAck(frame: ServerFrame<"view_ack">): void {
    if (this.#pendingLeadingView?.frame.input_id === frame.input_id) this.#pendingLeadingView = null;
  }

  #permissionUpdated(frame: ServerFrame<"permission_updated">): void {
    if (frame.participant_id === this.#participantId) this.#canDraw = frame.can_draw;
    this.#publishSummary("ready", null);
  }

  #view(frame: ServerFrame<"view">): void {
    if (this.#viewOwnerId && frame.owner_id !== this.#viewOwnerId) return;
    const rectangle = {
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
    const event = frame.owner_id ? { ...rectangle, ownerId: frame.owner_id, ownerSequence: frame.owner_sequence } : rectangle;
    if (!this.#viewVersions.isNew(event, event.participantId)) return;
    this.#viewVersions.remember(event, event.participantId);
    this.#emit(frame.origin_participant_id ? { ...event, originParticipantId: frame.origin_participant_id, originSequence: frame.origin_sequence, ...(frame.origin_epoch ? { originEpoch: frame.origin_epoch } : {}) } : event);
  }

  #drawAccess(frame: ServerFrame<"draw_access">): void {
    this.#canDraw = frame.can_draw;
    this.#capabilities = [...frame.capabilities];
    this.#drawPolicy = frame.policy;
    this.#drawPermissions = frame.grants.map((grant) => ({ participantId: grant.participant_id, canDraw: grant.can_draw }));
    this.#publishSummary(this.#summaryStatus, this.#summaryError);
  }

  #presentationUpdated(frame: ServerFrame<"presentation_updated">): void {
    this.#moveToScene(frame.scene_id, frame.revision);
    this.#presenting = frame.presenting;
    this.#presenterId = frame.presenter_id ?? null;
    this.#publishSummary("ready", null);
  }

  #resetRequired(frame: ServerFrame<"reset_required">): void {
    this.#moveToScene(frame.scene_id, null);
    this.#publishSummary("recovering", failure("request_snapshot", "cursor_reset_required", true, "Whiteboard snapshot recovery is required."));
    if (this.#presentationSupported) this.#socket?.close(CLIENT_RESTART_CLOSE_CODE, "whiteboard presentation recovery required");
    else this.#emit({ type: "reset_required", sceneId: frame.scene_id, reason: frame.reason });
  }

  #update(frame: ServerFrame<"update">): void {
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

  #updatePart(frame: ServerFrame<"update_part">): void {
    const result = this.#updateAssembler.add(frame);
    if (result.status === "incomplete") {
      if (result.started) {
        const timer = this.#clock().setTimeout(() => this.#expireUpdateAssembly(result.key), WhiteboardV1ProtocolLimits.multipartUpdateTimeoutMs);
        this.#updateAssemblyTimers.set(result.key, timer);
      }
      return;
    }

    this.#clearTimer(this.#updateAssemblyTimers, result.key);
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

  #welcome(frame: ServerFrame<"welcome">): void {
    if (this.#phase !== "authenticating") throw new Error("unexpected whiteboard welcome");
    this.#phase = "live";
    this.#viewsSupported = this.#hello.views;
    this.#adoptViewOwner("view_owner_id" in frame ? (frame.view_owner_id ?? null) : null);
    this.#reconnectAttempt = 0;
    this.#rejectedHelloRetries = 0;
    this.#participantId = frame.participant_id;
    this.#moveToScene(frame.scene_id, frame.revision);
    this.#capabilities = [...frame.capabilities];
    this.#canDraw = frame.can_draw;
    // Sync sends draw_access right after welcome when it accepted draw_policy_v1.
    this.#drawPolicy = null;
    this.#drawPermissions = [];
    this.#presentationSupported = "presenting" in frame;
    if ("presenting" in frame) {
      this.#presenting = frame.presenting;
      this.#presenterId = frame.presenter_id ?? null;
    } else {
      this.#presenting = false;
      this.#presenterId = null;
    }
    // A change restored from the store has no caller to reject, so the summary carries the refusal too.
    const refused = !this.#hello.drawPolicy && this.#dropPolicyChanges();
    this.#publishSummary("loading", refused ? policyUnavailable() : null);
    this.#watchdog.stop();
    this.#resumePendingOperations();
    this.#watchdog.startAfterWelcome();
  }

  #resumePendingOperations(): void {
    // Welcome replays every operation, so a retry timer from the last connection would send one twice.
    this.#clearOperationRetryTimers();
    for (const change of this.#accessChanges) if (change.state === "sent") change.state = "ready";
    this.#awaitingOperationIds.clear();
    this.#waitingForOperations = true;
    this.#sendInCreationOrder([...this.#operations.values()]);
    this.#requestSnapshotAfterOperations();
  }

  /** A Sync without draw_policy_v1 closes the socket on a policy change, so a change saved for a newer Sync is dropped, not replayed. */
  #dropPolicyChanges(): boolean {
    const dropped = this.#accessChanges.filter((change) => change.entry.pending.frame.type === "set_draw_policy");
    for (const { entry } of dropped) {
      const { operationId } = entry.pending;
      this.#removeAccessChange(operationId);
      this.#clearTimer(this.#operationRetryTimers, operationId);
      entry.deferred && rejectDeferred(entry.deferred, error(policyUnavailable()));
      this.#discardStoredOperation(operationId);
    }
    return dropped.length > 0;
  }

  #adoptViewOwner(ownerId: string | null): void {
    this.#viewOwnerId = ownerId;
    this.#latestViews.clear();
    this.#viewVersions.clear();
  }

  #requestSnapshotAfterOperations(): void {
    if (this.#phase !== "live" || !this.#waitingForOperations || this.#awaitingOperationIds.size > 0) return;
    this.#waitingForOperations = false;
    void this.#requestSnapshot().catch(() => undefined);
  }

  #requestSnapshot(): Promise<void> {
    const active = this.#snapshots.values().next().value;
    if (active) return active.deferred.promise;
    const requestId = this.#nextId();
    const frame = { type: "request_snapshot", request_id: requestId } as const;
    encodeWhiteboardV1ClientFrame(frame);
    const deferred = createDeferred<void>();
    this.#snapshots.set(requestId, { deferred, pages: new Map() });
    this.#send(frame);
    return deferred.promise;
  }

  #snapshotPage(frame: SnapshotPageFrame): void {
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
    this.#moveToScene(frame.scene_id, frame.revision);
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

  async #queueOperation(frame: WhiteboardV1LogicalOperationFrame): Promise<ChalkWhiteboardV1Commit> {
    this.#assertOperationCapacity();
    whiteboardV1OperationFrames(frame);
    const pending = {
      operationId: frame.operation_id,
      frame,
      createdAt: (this.#lastCreatedAt = Math.max(this.#now(), this.#lastCreatedAt + 1)),
      bytes: encodedWhiteboardV1FrameBytes(frame),
    } satisfies ChalkWhiteboardV1PendingOperation;
    const queuedBytes = this.#pendingEntries().reduce((total, entry) => total + entry.pending.bytes, 0);
    if (queuedBytes + pending.bytes > WhiteboardV1ProtocolLimits.multipartUpdateMaxBytes) {
      throw error(failure("submit_update", "unavailable", true, "Whiteboard operation byte capacity is full."));
    }
    const deferred = createDeferred<ChalkWhiteboardV1Commit>();
    const entry = { pending, deferred, retries: 0 };
    if (isAccessChange(frame)) return this.#queueAccessChange(entry, deferred);
    this.#savingOperations.set(frame.operation_id, entry);
    void this.#saveOperation(entry, deferred).catch((cause: unknown) => rejectDeferred(deferred, error(failure(frame.type, "unavailable", true, "Unable to queue the whiteboard operation."), cause)));
    return deferred.promise;
  }

  async #saveOperation(entry: OperationEntry, deferred: Deferred<ChalkWhiteboardV1Commit>): Promise<void> {
    const { pending } = entry;
    const saveFailure = await this.#persist(pending);
    this.#savingOperations.delete(pending.operationId);
    if (saveFailure) {
      rejectDeferred(deferred, saveFailure);
      return;
    }
    this.#operations.set(pending.operationId, entry);
    if (this.#phase === "live" && this.#snapshots.size === 0) {
      if (this.#waitingForOperations) this.#awaitingOperationIds.add(pending.operationId);
      this.#sendOperation(pending.frame);
    }
  }

  /**
   * The change joins the list before its save starts, so a later change can't overtake it while it saves. The caller
   * gets its one promise at once: a refusal or a rejected connection during the save settles it without waiting for
   * the store, and a failed save settles it otherwise.
   */
  #queueAccessChange(entry: OperationEntry, deferred: Deferred<ChalkWhiteboardV1Commit>): Promise<ChalkWhiteboardV1Commit> {
    const change: AccessChange = { entry, state: "saving" };
    this.#accessChanges.push(change);
    void this.#saveAccessChange(change, deferred);
    return deferred.promise;
  }

  async #saveAccessChange(change: AccessChange, deferred: Deferred<ChalkWhiteboardV1Commit>): Promise<void> {
    const { pending } = change.entry;
    const saveFailure = await this.#persist(pending);
    if (saveFailure) {
      this.#removeAccessChange(pending.operationId);
      this.#sendNextAccessChange();
      rejectDeferred(deferred, saveFailure);
      return;
    }
    // The client fell back to a Sync without draw_policy_v1 during the save, which already refused the change.
    if (!this.#accessChanges.includes(change)) {
      this.#discardStoredOperation(pending.operationId);
      return;
    }
    change.state = "ready";
    this.#sendNextAccessChange();
  }

  /** Returns the failure instead of throwing it, so an access change can hand it to the promise its caller holds. */
  async #persist(pending: ChalkWhiteboardV1PendingOperation): Promise<ChalkWhiteboardV1Error | undefined> {
    let storeWrite: Promise<void> | undefined;
    try {
      storeWrite = this.#store.put(pending);
      this.#pendingStoreWrites.add(storeWrite);
      await storeWrite;
      return undefined;
    } catch (cause) {
      // A store can fail after it wrote, and a stored operation the client forgot would replay on the next start.
      this.#discardStoredOperation(pending.operationId);
      return error(failure(pending.frame.type, "unavailable", true, "Unable to persist the whiteboard operation."), cause);
    } finally {
      if (storeWrite) this.#pendingStoreWrites.delete(storeWrite);
    }
  }

  #discardStoredOperation(operationId: string): void {
    const cleanup = this.#store.remove(operationId).catch(() => undefined);
    this.#pendingStoreWrites.add(cleanup);
    void cleanup.finally(() => this.#pendingStoreWrites.delete(cleanup));
  }

  #commit(frame: ServerFrame<"commit">): void {
    const entry = this.#sentEntry(frame.operation_id);
    if (!entry) return;
    this.#forgetOperation(frame.operation_id);
    this.#clearTimer(this.#operationRetryTimers, frame.operation_id);
    this.#moveToScene(frame.scene_id, frame.revision);
    this.#awaitingOperationIds.delete(frame.operation_id);
    this.#publishSummary("ready", null);
    entry.deferred &&
      resolveDeferred(entry.deferred, {
        operationId: frame.operation_id,
        sceneId: frame.scene_id,
        revision: frame.revision,
      });
    void this.#store.remove(frame.operation_id).catch(() => undefined);
    this.#sendNextAccessChange();
    this.#requestSnapshotAfterOperations();
  }

  #operationError(frame: ServerFrame<"operation_error">): void {
    const entry = this.#sentEntry(frame.correlation_id);
    if (entry) {
      this.#failOperation(entry, frame);
      return;
    }
    const snapshot = this.#snapshots.get(frame.correlation_id);
    if (snapshot) this.#failSnapshot(snapshot, frame);
  }

  #failOperation(entry: OperationEntry, frame: ServerFrame<"operation_error">): void {
    if (frame.recoverable && retryableOperationCode(frame.code)) {
      this.#scheduleOperationRetry(frame.correlation_id, entry);
      return;
    }
    this.#forgetOperation(frame.correlation_id);
    this.#clearTimer(this.#operationRetryTimers, frame.correlation_id);
    this.#awaitingOperationIds.delete(frame.correlation_id);
    const operationFailure = failure(entry.pending.frame.type, mapErrorCode(frame.code), frame.recoverable, frame.message);
    entry.deferred && rejectDeferred(entry.deferred, error(operationFailure));
    this.#publishSummary("ready", operationFailure);
    void this.#store.remove(frame.correlation_id).catch(() => undefined);
    this.#sendNextAccessChange();
    this.#requestSnapshotAfterOperations();
  }

  #failSnapshot(snapshot: SnapshotAssembly, frame: ServerFrame<"operation_error">): void {
    this.#snapshots.delete(frame.correlation_id);
    const snapshotFailure = failure("request_snapshot", mapErrorCode(frame.code), frame.recoverable, frame.message);
    const snapshotError = error(snapshotFailure);
    this.#publishSummary(frame.recoverable ? "recovering" : "failed", snapshotFailure);
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
    this.#sendInCreationOrder([...this.#operations.values()].filter((entry) => !this.#awaitingOperationIds.has(entry.pending.operationId)));
  }

  #sendNextAccessChange(): void {
    this.#sendInCreationOrder([]);
  }

  /** Sends the operations, and the first access change when it may go, in the order they were made. */
  #sendInCreationOrder(operations: readonly OperationEntry[]): void {
    const head = this.#sendableAccessChange();
    if (head) head.state = "sent";
    const entries = [...operations, ...(head ? [head.entry] : [])].sort((left, right) => compareChalkWhiteboardV1PendingOperations(left.pending, right.pending));
    for (const entry of entries) {
      this.#clearTimer(this.#operationRetryTimers, entry.pending.operationId);
      if (this.#phase !== "live") break;
      if (this.#waitingForOperations) this.#awaitingOperationIds.add(entry.pending.operationId);
      this.#sendOperation(entry.pending.frame);
    }
  }

  #releaseOperationRetryToSnapshotFlush(operationId: string, entry: OperationEntry): void {
    this.#awaitingOperationIds.delete(operationId);
    const change = this.#accessChange(operationId);
    if (change?.state === "sent") change.state = "ready";
    if (!change) this.#scheduleOperationRetry(operationId, entry);
  }

  /**
   * Access changes go out one at a time in the host's order, so a retried older change can't land after a newer one.
   * Sync also stores a per-person choice according to the policy it lands under, so their order matters too.
   */
  #sendableAccessChange(): AccessChange | undefined {
    if (this.#phase !== "live" || this.#snapshots.size > 0) return undefined;
    const head = this.#accessChanges[0];
    if (head?.state !== "ready" || this.#accessChanges.some((change) => change.state === "sent")) return undefined;
    return head;
  }

  /** A restart keeps the changes it already holds, so a restored one goes where its creation puts it. */
  #restoreAccessChange(pending: ChalkWhiteboardV1PendingOperation): void {
    const later = this.#accessChanges.findIndex((change) => compareChalkWhiteboardV1PendingOperations(change.entry.pending, pending) > 0);
    this.#accessChanges.splice(later < 0 ? this.#accessChanges.length : later, 0, { entry: { pending, retries: 0 }, state: "ready" });
  }

  #accessChange(operationId: string): AccessChange | undefined {
    return this.#accessChanges.find((change) => change.entry.pending.operationId === operationId);
  }

  #removeAccessChange(operationId: string): void {
    const index = this.#accessChanges.findIndex((change) => change.entry.pending.operationId === operationId);
    if (index >= 0) this.#accessChanges.splice(index, 1);
  }

  /** The operation a receipt or an error can be about: any queued operation, or the access change that was sent. */
  #sentEntry(operationId: string): OperationEntry | undefined {
    const change = this.#accessChange(operationId);
    return this.#operations.get(operationId) ?? (change?.state === "sent" ? change.entry : undefined);
  }

  #forgetOperation(operationId: string): void {
    this.#operations.delete(operationId);
    this.#removeAccessChange(operationId);
  }

  #pendingEntries(): OperationEntry[] {
    return [...this.#operations.values(), ...this.#savingOperations.values(), ...this.#accessChanges.map((change) => change.entry)];
  }

  #operationCount(): number {
    return this.#operations.size + this.#savingOperations.size + this.#accessChanges.length;
  }

  #scheduleOperationRetry(operationId: string, entry: OperationEntry): void {
    if (this.#operationRetryTimers.has(operationId)) return;
    entry.retries += 1;
    const timer = this.#clock().setTimeout(
      () => {
        this.#operationRetryTimers.delete(operationId);
        if (this.#phase !== "live" || this.#sentEntry(operationId) !== entry) return;
        if (this.#snapshots.size > 0) {
          this.#releaseOperationRetryToSnapshotFlush(operationId, entry);
          return;
        }
        this.#sendOperation(entry.pending.frame);
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
    if (phase === "live") this.#hello = FIRST_HELLO;
    return true;
  }

  #stepDownHello(): boolean {
    if (this.#hello === BARE_HELLO) return false;
    this.#hello = nextHelloLevel(this.#hello);
    if (!this.#hello.views) this.#pendingLeadingView = null;
    return true;
  }

  #retryHello(): boolean {
    if (this.#rejectedHelloRetries >= MAX_REJECTED_HELLO_RETRIES) return false;
    this.#rejectedHelloRetries += 1;
    return true;
  }

  #resetDisconnectedState(): void {
    this.#viewOwnerId = null;
    this.#latestViews.clear();
    this.#viewVersions.clear();
    this.#socket = null;
    this.#clearDial();
    this.#watchdog.stop();
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
    const delay = reconnectDelay(configuredDelay, this.#reconnectAttempt, this.#options.random ?? Math.random);
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
    if (this.#operationCount() >= WhiteboardV1ProtocolLimits.pendingOperationMaxItems) {
      throw error(failure("submit_update", "unavailable", true, "Whiteboard operation capacity is full."));
    }
  }

  #nextId(): string {
    const id = this.#options.ids?.next() ?? crypto.randomUUID();
    if (this.#operations.has(id) || this.#savingOperations.has(id) || this.#accessChange(id) || this.#snapshots.has(id)) {
      throw error(failure("submit_update", "invalid_payload", false, "Whiteboard operation ID is already pending."));
    }
    return id;
  }

  #send(frame: WhiteboardV1ClientFrame): void {
    this.#socket?.send(encodeWhiteboardV1ClientFrame(frame));
  }

  #sendOperation(frame: ChalkWhiteboardV1PendingOperation["frame"]): void {
    const socket = this.#socket;
    if (!socket || this.#phase !== "live") return;
    for (const outbound of whiteboardV1OperationFrames(frame)) {
      const wire = encodeWhiteboardV1ClientFrame(outbound);
      try {
        socket.send(wire);
      } catch {
        // A partial send is not a receipt. Keep the operation and its caller for the next connection.
        this.#disconnected(socket, DEPENDENCY_UNAVAILABLE_CLOSE_CODE);
        try {
          socket.close(CLIENT_RESTART_CLOSE_CODE, "whiteboard send failed");
        } catch {
          // Reconnect already owns recovery even if the broken socket cannot close.
        }
        return;
      }
      if (socket !== this.#socket || this.#phase !== "live") return;
    }
  }

  #emit(event: ChalkWhiteboardV1Event): void {
    if (event.type === "snapshot") this.#latestSnapshot = event;
    if (event.type === "view") {
      this.#latestViews.delete(event.participantId);
      this.#latestViews.set(event.participantId, event);
      if (this.#latestViews.size > WhiteboardV1ProtocolLimits.viewPeopleMaxItems) {
        const oldest = this.#latestViews.keys().next().value;
        if (oldest !== undefined) this.#latestViews.delete(oldest);
      }
    }
    for (const listener of this.#listeners) listener(event);
    // The existing snapshot boundary replaces cached views without a new public event variant.
    if (event.type === "snapshot") {
      for (const view of this.#latestViews.values()) {
        for (const listener of this.#listeners) listener({ ...view, bring: false });
      }
    }
  }

  #publishSummary(status: ChalkWhiteboardSummary["status"], summaryError: ChalkWhiteboardV1Failure | null): void {
    this.#summaryStatus = status;
    this.#summaryError = summaryError;
    if (status === "failed") this.#pendingLeadingView = null;
    if (status === "ready") this.#flushPendingBring();
    const summary = this.#summary();
    if (this.#options.onSummary) this.#notifySummaryListener(this.#options.onSummary, summary);
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
      presenterId: this.#presenterId,
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

  #rejectSnapshots(value: ChalkWhiteboardV1Failure): void {
    for (const assembly of this.#snapshots.values()) rejectDeferred(assembly.deferred, error(value));
    this.#snapshots.clear();
  }

  #rejectOperationCallers(value: ChalkWhiteboardV1Failure): void {
    for (const entry of this.#pendingEntries()) entry.deferred && rejectDeferred(entry.deferred, error({ ...value, operation: entry.pending.frame.type }));
  }

  #clearOperationRetryTimers(): void {
    for (const timer of this.#operationRetryTimers.values()) this.#clock().clearTimeout(timer);
    this.#operationRetryTimers.clear();
  }

  #clearUpdateAssemblies(): void {
    for (const timer of this.#updateAssemblyTimers.values()) this.#clock().clearTimeout(timer);
    this.#updateAssemblyTimers.clear();
    this.#updateAssembler.clear();
  }

  #clearTimer(timers: Map<string, unknown>, key: string): void {
    const timer = timers.get(key);
    if (timer === undefined) return;
    this.#clock().clearTimeout(timer);
    timers.delete(key);
  }

  #clearReconnect(): void {
    if (this.#reconnectTimer === undefined) return;
    this.#clock().clearTimeout(this.#reconnectTimer);
    this.#reconnectTimer = undefined;
  }

  #removeVisibilityListener(): void {
    globalThis.document?.removeEventListener("visibilitychange", this.#visibilityChanged);
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

function dispatchFrame<Type extends keyof ServerFrameByType>(handlers: FrameHandlers, type: Type, frame: ServerFrameByType[Type]): void {
  handlers[type](frame);
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

function retryableOperationCode(code: ServerFrame<"operation_error">["code"]): boolean {
  return code === "unavailable" || code === "overloaded" || code === "rate_limited" || code === "storage_unavailable";
}

function policyUnavailable(): ChalkWhiteboardV1Failure {
  return failure("set_draw_policy", "unavailable", true, "The call-wide drawing policy is unavailable on this Sync server.");
}

function terminalCloseCode(closeCode: number): boolean {
  return closeCode === 1008 || closeCode === 1009;
}

function mapErrorCode(code: ServerFrame<"operation_error">["code"]): ChalkWhiteboardV1Failure["code"] {
  return code === "overloaded" || code === "rate_limited" ? "unavailable" : code;
}

function failure(operation: ChalkWhiteboardV1Operation, code: ChalkWhiteboardV1Failure["code"], recoverable: boolean, message: string): ChalkWhiteboardV1Failure {
  return { operation, code, recoverable, message };
}

function error(value: ChalkWhiteboardV1Failure, cause?: unknown): ChalkWhiteboardV1Error {
  return new ChalkWhiteboardV1Error(value, cause === undefined ? undefined : { cause });
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: Deferred<T>["resolve"];
  let reject!: Deferred<T>["reject"];
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject, settled: false };
}

function isAccessChange(frame: ChalkWhiteboardV1PendingOperation["frame"]): boolean {
  return frame.type === "set_draw_policy" || frame.type === "set_draw_permission";
}

function resolveDeferred<T>(deferred: Deferred<T>, value: T): void {
  if (deferred.settled) return;
  deferred.settled = true;
  deferred.resolve(value);
}

function rejectDeferred<T>(deferred: Deferred<T>, value: unknown): void {
  if (deferred.settled) return;
  deferred.settled = true;
  deferred.reject(value);
}

function assertWhiteboardV1Url(url: string): void {
  const parsed = new URL(url);
  if ((parsed.protocol !== "ws:" && parsed.protocol !== "wss:") || parsed.pathname !== WHITEBOARD_PATH) {
    throw new TypeError("whiteboard-v1 URL must use ws(s) and the /v1/whiteboard route");
  }
}
