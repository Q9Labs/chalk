import { Clock, Context, Effect, Fiber, Layer, ManagedRuntime, Queue, Random, Schedule, SubscriptionRef, type Scope } from "effect";
import { reduceConnection, retryDelay, type SyncBackoffOptions } from "./connection";
import { copyReplica, optimisticSnapshotState, pendingCommandBytes, reduceCanonicalEvent, restoreSnapshot } from "./client-state";
import { canonicalIncludesRevision, canonicalRevision, helloFrame, requireCanonical, requireReducedCanonical, requireRestoredCanonical, requireSnapshot, sameAcknowledgement } from "./client-frame-helpers";
import { SyncDiagnosticBuffer, type SyncDiagnostics } from "./diagnostics";
import { SyncCapacityError, SyncCommandValidationError, SyncPersistenceError } from "./errors";
import { InMemoryPendingCommandStore, type PendingCommandStore } from "./persistence";
import { comparePending, copyPending, isCommandId, isStoredPending, MAX_PENDING_COMMANDS, pendingLimitsFrom, validateCommand, validateLimits, type PendingCommandLimits } from "./pending-command-validation";
import { beginRecovery, acceptReplayPage, completeRecovery, MAX_INBOUND_SERVER_FRAME_BYTES, type RecoveryPlan, RecoveryValidationError } from "./recovery";
import type { SyncProtocolCodec } from "./protocol";
import type {
  AckFrame,
  CanonicalReplica,
  ClientFrame,
  CommittedAck,
  ControlEvent,
  EventFrame,
  PendingCommand,
  RejectedAck,
  RecoveryCompleteFrame,
  ReplayPageFrame,
  RetryableErrorFrame,
  ServerErrorFrame,
  ServerFrame,
  SyncClock,
  SyncCommand,
  SyncCommandFailure,
  SyncConnectionState,
  SyncIdGenerator,
  SyncLifecycle,
  SyncLifecycleEvent,
  SyncRandom,
  SyncSnapshot,
  SyncSocket,
  SyncWebSocketFactory,
  WelcomeFrame,
} from "./types";

const encoder = new TextEncoder();
const MAX_FAILURES = 32;
const HEARTBEAT_MS = 20_000;

const lifecycleSignals: Record<SyncLifecycleEvent, readonly ["online" | "active", boolean]> = {
  online: ["online", true],
  offline: ["online", false],
  active: ["active", true],
  inactive: ["active", false],
};

export type SyncClientOptions = {
  readonly url: string;
  readonly token: () => Promise<string>;
  readonly webSocket: SyncWebSocketFactory;
  readonly pendingStore?: PendingCommandStore;
  readonly clock?: SyncClock;
  readonly random?: SyncRandom;
  readonly ids?: SyncIdGenerator;
  readonly lifecycle?: SyncLifecycle;
  readonly codec: SyncProtocolCodec;
  readonly backoff?: SyncBackoffOptions;
  readonly diagnosticsCapacity?: number;
  readonly limits?: {
    readonly maxPendingCommands?: number;
    readonly maxPendingBytes?: number;
    readonly maxPendingAgeMs?: number;
  };
};

type InboundFrame = {
  readonly data: unknown;
  readonly socket: SyncSocket;
};

export type SyncEngineEffectService = {
  readonly snapshotRef: SubscriptionRef.SubscriptionRef<SyncSnapshot>;
  readonly getDiagnostics: () => SyncDiagnostics;
  readonly getSnapshot: () => SyncSnapshot;
  readonly refresh: () => Effect.Effect<void>;
  readonly send: (command: SyncCommand) => Effect.Effect<string, SyncCapacityError | SyncCommandValidationError | SyncPersistenceError>;
  readonly start: () => Effect.Effect<void, Error>;
  readonly stop: () => Effect.Effect<void>;
  readonly subscribe: (listener: (snapshot: SyncSnapshot) => void) => () => void;
};

export type SyncTransportCapability = Pick<SyncClientOptions, "token" | "url" | "webSocket">;
export type SyncTimeCapability = Pick<SyncClientOptions, "clock" | "ids" | "random">;
export type SyncPolicyCapability = Pick<SyncClientOptions, "backoff" | "diagnosticsCapacity" | "limits">;

export class SyncTransportService extends Context.Service<SyncTransportService, SyncTransportCapability>()("@chalk/sync/Transport") {}
export class SyncPendingStoreService extends Context.Service<SyncPendingStoreService, PendingCommandStore>()("@chalk/sync/PendingStore") {}
export class SyncTimeService extends Context.Service<SyncTimeService, Required<SyncTimeCapability>>()("@chalk/sync/Time") {}
export class SyncLifecycleService extends Context.Service<SyncLifecycleService, SyncLifecycle | undefined>()("@chalk/sync/Lifecycle") {}
export class SyncCodecService extends Context.Service<SyncCodecService, SyncProtocolCodec>()("@chalk/sync/Codec") {}
export class SyncPolicyService extends Context.Service<SyncPolicyService, SyncPolicyCapability>()("@chalk/sync/Policy") {}

export const makeSyncTransportLayer = (options: SyncTransportCapability) => Layer.succeed(SyncTransportService, options);
export const makeSyncPendingStoreLayer = (store?: PendingCommandStore) => Layer.succeed(SyncPendingStoreService, store ?? new InMemoryPendingCommandStore());
export const makeSyncLifecycleLayer = (lifecycle?: SyncLifecycle) => Layer.succeed(SyncLifecycleService, lifecycle);
export const makeSyncCodecLayer = (codec: SyncProtocolCodec) => Layer.succeed(SyncCodecService, codec);
export const makeSyncPolicyLayer = (options: SyncPolicyCapability) => Layer.succeed(SyncPolicyService, options);

/** Uses Effect Clock and Random defaults while preserving public capability overrides. */
export const makeSyncTimeLayer = (options: SyncTimeCapability) =>
  Layer.effect(
    SyncTimeService,
    Effect.gen(function* () {
      const clock = yield* Clock.Clock;
      const random = yield* Random.Random;
      return {
        clock: options.clock ?? effectClock(clock),
        ids: options.ids ?? effectIds(random),
        random: options.random ?? (() => random.nextDoubleUnsafe()),
      };
    }),
  );

/** Effect-native sync engine service. The compatibility client below owns its runtime. */
export class SyncEngineService extends Context.Service<SyncEngineService, SyncEngineEffectService>()("@chalk/sync/SyncEngine") {}

/** Builds a scoped sync engine using the existing public option capabilities. */
export const makeSyncEngineLayer = (options: SyncClientOptions) =>
  makeSyncEngineLayerFromServices().pipe(Layer.provideMerge([makeSyncTransportLayer(options), makeSyncPendingStoreLayer(options.pendingStore), makeSyncTimeLayer(options), makeSyncLifecycleLayer(options.lifecycle), makeSyncCodecLayer(options.codec), makeSyncPolicyLayer(options)]));

/** Builds the engine from individually replaceable capability layers. */
export const makeSyncEngineLayerFromServices = () =>
  Layer.effect(
    SyncEngineService,
    Effect.gen(function* () {
      const transport = yield* Effect.service(SyncTransportService);
      const pendingStore = yield* Effect.service(SyncPendingStoreService);
      const time = yield* Effect.service(SyncTimeService);
      const lifecycle = yield* Effect.service(SyncLifecycleService);
      const codec = yield* Effect.service(SyncCodecService);
      const policy = yield* Effect.service(SyncPolicyService);
      return yield* makeSyncEngineService({ ...transport, ...time, ...policy, codec, lifecycle, pendingStore });
    }),
  );

export function makeSyncEngineService(options: SyncClientOptions): Effect.Effect<SyncEngineEffectService, never, Scope.Scope> {
  return Effect.gen(function* () {
    const inbound = yield* Queue.unbounded<InboundFrame>();
    const engine = new SyncEngine(options, inbound);
    const snapshotRef = yield* SubscriptionRef.make(engine.getSnapshot());
    engine.attachSnapshotRef(snapshotRef);
    yield* Queue.take(inbound).pipe(
      Effect.flatMap((frame) => Effect.promise(() => engine.handleInbound(frame.socket, frame.data)).pipe(Effect.catch(() => Effect.sync(() => engine.protocolFailure("inbound_failure"))))),
      Effect.forever,
      Effect.forkScoped({ startImmediately: true }),
    );
    yield* Effect.addFinalizer(() => Effect.sync(() => engine.dispose()));
    return engine.effectService(snapshotRef);
  });
}

class SyncEngine {
  readonly #store: PendingCommandStore;
  readonly #clock: SyncClock;
  readonly #random: SyncRandom;
  readonly #ids: SyncIdGenerator;
  readonly #codec: SyncProtocolCodec;
  readonly #diagnostics: SyncDiagnosticBuffer;
  readonly #limits: PendingCommandLimits;
  readonly #backoff: SyncBackoffOptions;
  readonly #listeners = new Set<(snapshot: SyncSnapshot) => void>();
  readonly #pending = new Map<string, PendingCommand>();
  readonly #acknowledged = new Map<string, CommittedAck>();
  readonly #settled = new Map<string, CommittedAck>();
  readonly #failures: SyncCommandFailure[] = [];
  readonly #lifecycle?: SyncLifecycle;
  #connection: SyncConnectionState = { phase: "idle" };
  #canonical: CanonicalReplica | null = null;
  #participantSessionId: string | null = null;
  #socket: SyncSocket | null = null;
  #recovery: RecoveryPlan | null = null;
  #connectionFiber: Fiber.Fiber<void, never> | undefined;
  #retryFiber: Fiber.Fiber<void, never> | undefined;
  #heartbeatFiber: Fiber.Fiber<unknown, never> | undefined;
  #retryTimer: unknown;
  #heartbeatTimer: unknown;
  #unsubscribeLifecycle: (() => void) | undefined;
  #started = false;
  #transportAvailable = true;
  #online = true;
  #active = true;
  #loaded = false;
  #pendingLoad: Promise<void> | undefined;
  #startGeneration = 0;
  #reservedPendingCommands = 0;
  #reservedPendingBytes = 0;
  readonly #inbound: Queue.Queue<InboundFrame>;
  #snapshotRef: SubscriptionRef.SubscriptionRef<SyncSnapshot> | undefined;

  constructor(
    readonly options: SyncClientOptions,
    inbound: Queue.Queue<InboundFrame>,
  ) {
    this.#inbound = inbound;
    this.#store = options.pendingStore ?? new InMemoryPendingCommandStore();
    this.#clock = options.clock ?? effectClock(Effect.runSync(Clock.Clock));
    this.#random = options.random ?? (() => Effect.runSync(Random.Random).nextDoubleUnsafe());
    this.#ids = options.ids ?? effectIds(Effect.runSync(Random.Random));
    this.#codec = options.codec;
    this.#diagnostics = new SyncDiagnosticBuffer(options.diagnosticsCapacity);
    this.#limits = pendingLimitsFrom(options.limits);
    this.#backoff = options.backoff ?? {};
    this.#lifecycle = options.lifecycle;
    validateLimits(this.#limits);
  }

  attachSnapshotRef(snapshotRef: SubscriptionRef.SubscriptionRef<SyncSnapshot>): void {
    this.#snapshotRef = snapshotRef;
  }

  effectService(snapshotRef: SubscriptionRef.SubscriptionRef<SyncSnapshot>): SyncEngineEffectService {
    return {
      snapshotRef,
      getDiagnostics: () => this.getDiagnostics(),
      getSnapshot: () => this.getSnapshot(),
      refresh: () => Effect.sync(() => this.refresh()),
      send: (command) => Effect.promise(() => this.send(command)),
      start: () => Effect.promise(() => this.start()),
      stop: () => Effect.sync(() => this.stop()),
      subscribe: (listener) => this.subscribe(listener),
    };
  }

  dispose(): void {
    this.stop();
    Effect.runSync(Queue.shutdown(this.#inbound));
  }

  async start(): Promise<void> {
    if (this.#started) {
      return;
    }
    const startGeneration = ++this.#startGeneration;
    this.#started = true;
    if (this.#connection.phase === "stopped" && this.#connection.reason === "stopped") {
      this.#connection = { phase: "idle" };
    }
    try {
      await this.#loadPending();
    } catch {
      if (this.#started && this.#startGeneration === startGeneration) {
        this.#started = false;
      }
      throw new Error("unable to load pending sync commands");
    }
    if (this.#started && this.#startGeneration === startGeneration) {
      this.#unsubscribeLifecycle = this.#lifecycle?.subscribe((event) => this.#onLifecycle(event));
      if (this.#transportAvailable) {
        this.#connect();
      }
    }
  }

  stop(): void {
    if (!this.#started && this.#connection.phase === "stopped") {
      return;
    }
    this.#started = false;
    this.#unsubscribeLifecycle?.();
    this.#unsubscribeLifecycle = undefined;
    this.#clearTimers();
    this.#closeSocket(1000, "client stopped");
    this.#recovery = null;
    this.#connection = reduceConnection(this.#connection, { type: "stop" });
    this.#trace("connection", "stopped", {});
    this.#emit();
  }

  refresh(): void {
    if (!this.#started || this.#connection.phase === "ended" || (this.#connection.phase === "stopped" && this.#connection.reason !== "rejoin_required")) {
      return;
    }
    this.#trace("connection", "refresh_requested", {});
    if (this.#connection.phase === "stopped") {
      this.#connection = { phase: "idle" };
      this.#connect();
      return;
    }
    this.#scheduleRetry("refresh", 0);
  }

  async send(command: SyncCommand): Promise<string> {
    this.#expirePending();
    validateCommand(command);
    const pending = this.#createPending(command);
    try {
      await this.#persistPending(pending);
      this.#enqueuePending(pending);
      return pending.commandId;
    } finally {
      this.#releasePendingCapacity(pending.bytes);
    }
  }

  #createPending(command: SyncCommand): PendingCommand {
    const commandId = this.#ids.next();
    if (!isCommandId(commandId)) {
      throw new SyncCommandValidationError("generated command ID must contain 16 to 64 URL-safe ASCII characters");
    }
    const bytes = pendingCommandBytes(commandId, command);
    this.#reservePendingCapacity(bytes);
    return { commandId, command, createdAt: this.#clock.now(), bytes };
  }

  #reservePendingCapacity(bytes: number): void {
    if (this.#pending.size + this.#reservedPendingCommands >= this.#limits.maxPendingCommands) {
      throw new SyncCapacityError("count");
    }
    if (this.#pendingBytes() + this.#reservedPendingBytes + bytes > this.#limits.maxPendingBytes) {
      throw new SyncCapacityError("bytes");
    }
    this.#reservedPendingCommands += 1;
    this.#reservedPendingBytes += bytes;
  }

  #releasePendingCapacity(bytes: number): void {
    this.#reservedPendingCommands -= 1;
    this.#reservedPendingBytes -= bytes;
  }

  async #persistPending(pending: PendingCommand): Promise<void> {
    try {
      await this.#store.put(pending);
    } catch {
      this.#trace("persistence", "put_failed", {});
      throw new SyncPersistenceError("unable to persist a pending sync command");
    }
  }

  #enqueuePending(pending: PendingCommand): void {
    this.#pending.set(pending.commandId, pending);
    this.#trace("command", "enqueued", { pending: this.#pending.size, bytes: this.#pendingBytes() });
    this.#emit();
    this.#sendPending(pending);
  }

  getSnapshot(): SyncSnapshot {
    const pending = [...this.#pending.values()].sort(comparePending);
    return {
      connection: { ...this.#connection },
      canonical: this.#canonical ? copyReplica(this.#canonical) : null,
      optimistic: optimisticSnapshotState(this.#canonical, this.#participantSessionId, pending),
      pending: { count: pending.length, bytes: pending.reduce((total, command) => total + command.bytes, 0), commands: pending.map(copyPending) },
      failures: this.#failures.map((failure) => ({ ...failure })),
    };
  }

  subscribe(listener: (snapshot: SyncSnapshot) => void): () => void {
    this.#listeners.add(listener);
    listener(this.getSnapshot());
    return () => this.#listeners.delete(listener);
  }

  getDiagnostics(): SyncDiagnostics {
    return this.#diagnostics.snapshot();
  }

  #connect(): void {
    if (!this.#canConnect()) {
      return;
    }
    this.#clearRetryTimer();
    this.#connection = reduceConnection(this.#connection, { type: "start" });
    this.#emit();
    try {
      const socket = this.options.webSocket.connect(this.options.url);
      this.#socket = socket;
      socket.onopen = () => this.#onSocketOpen(socket);
      socket.onmessage = (event) => this.#enqueueInbound(socket, event.data);
      socket.onclose = (event) => this.#onSocketClose(socket, event.code);
      socket.onerror = () => this.#scheduleRetry("socket_error");
    } catch {
      this.#scheduleRetry("connect_failed");
    }
  }

  #canConnect(): boolean {
    if (!this.#started) {
      return false;
    }
    if (!this.#transportAvailable) {
      return false;
    }
    return this.#connection.phase !== "ended" && this.#connection.phase !== "stopped";
  }

  #onSocketOpen(socket: SyncSocket): void {
    if (!this.#isCurrentSocket(socket)) {
      return;
    }
    this.#connection = reduceConnection(this.#connection, { type: "socket_open" });
    this.#emit();
    this.#authenticateSocket(socket);
  }

  #authenticateSocket(socket: SyncSocket): void {
    this.#clearConnectionFiber();
    this.#connectionFiber = Effect.runFork(
      Effect.promise(() => this.options.token()).pipe(
        Effect.tap((token) => Effect.sync(() => this.#finishAuthentication(socket, token))),
        Effect.catch(() => Effect.sync(() => this.#scheduleRetry("authentication_failed"))),
        Effect.asVoid,
      ),
    );
  }

  #finishAuthentication(socket: SyncSocket, token: string): void {
    if (!this.#isCurrentSocket(socket)) {
      return;
    }
    this.#sendFrame(helloFrame(token, this.#canonical));
    this.#connection = reduceConnection(this.#connection, { type: "hello_sent" });
    this.#trace("connection", "hello_sent", { revision: canonicalRevision(this.#canonical) });
    this.#emit();
  }

  #enqueueInbound(socket: SyncSocket, data: unknown): void {
    Queue.offerUnsafe(this.#inbound, { socket, data });
  }

  async handleInbound(socket: SyncSocket, data: unknown): Promise<void> {
    if (!this.#isCurrentSocket(socket)) {
      return;
    }
    if (typeof data !== "string" || encoder.encode(data).byteLength > MAX_INBOUND_SERVER_FRAME_BYTES) {
      this.#protocolFailure("invalid_inbound_frame");
      return;
    }
    const frame = this.#codec.decodeServer(data);
    await this.#handleFrame(frame);
  }

  async #handleFrame(frame: ServerFrame): Promise<void> {
    switch (frame.type) {
      case "welcome":
        await this.#handleWelcome(frame);
        return;
      case "replay_page":
        await this.#handleReplayPage(frame);
        return;
      case "recovery_complete":
        await this.#handleRecoveryComplete(frame);
        return;
      case "event":
        await this.#handleLiveEvent(frame);
        return;
      case "ack":
        await this.#handleAck(frame);
        return;
      case "retryable_error":
        await this.#handleRetryableError(frame);
        return;
      case "error":
        await this.#handleServerError(frame);
        return;
      case "pong":
        return;
      default:
        this.#protocolFailure("unknown_server_frame");
    }
  }

  async #handleLiveEvent(frame: EventFrame): Promise<void> {
    if (this.#connection.phase !== "live") {
      this.#protocolFailure("event_before_live");
      return;
    }
    await this.#applyEvent(frame, true);
  }

  async #handleRetryableError(frame: RetryableErrorFrame): Promise<void> {
    this.#trace("command", "retryable_error", { code: frame.code, pending: this.#pending.size });
  }

  async #handleServerError(frame: ServerErrorFrame): Promise<void> {
    this.#protocolFailure(`server_${frame.code}`);
  }

  async #handleWelcome(frame: WelcomeFrame): Promise<void> {
    if (!this.#expectsWelcome(frame)) {
      this.#protocolFailure("unexpected_welcome");
      return;
    }
    if (frame.mode === "terminal") {
      this.#handleTerminalWelcome(frame);
      return;
    }
    await this.#startRecovery(frame);
  }

  #expectsWelcome(frame: WelcomeFrame): boolean {
    return frame.protocol === 2 && this.#connection.phase === "recovering";
  }

  #handleTerminalWelcome(frame: WelcomeFrame): void {
    this.#connection = frame.terminalReason === "session_ended" ? reduceConnection(this.#connection, { type: "ended" }) : reduceConnection(this.#connection, { type: "rejoin_required" });
    this.#trace("recovery", "terminal", { reason: frame.terminalReason ?? "unknown", revision: frame.head.revision });
    this.#emit();
  }

  async #startRecovery(frame: WelcomeFrame): Promise<void> {
    try {
      const plan = beginRecovery(frame, this.#canonical);
      if (frame.mode === "snapshot") {
        await this.#installSnapshot(frame);
      }
      this.#participantSessionId = frame.participantSessionId;
      this.#recovery = plan;
      this.#connection = reduceConnection(this.#connection, { type: "recovery_started", recoveryId: frame.recoveryId });
      if (frame.mode === "snapshot") {
        this.#acknowledgeRecovery(frame.recoveryId);
      }
      this.#trace("recovery", "welcome", { mode: frame.mode, revision: frame.head.revision });
      this.#emit();
    } catch (error) {
      this.#recoverFromValidation(error);
    }
  }

  async #installSnapshot(frame: WelcomeFrame): Promise<void> {
    const restored = await restoreSnapshot(requireSnapshot(frame));
    this.#canonical = requireRestoredCanonical(restored);
  }

  async #handleReplayPage(frame: ReplayPageFrame): Promise<void> {
    if (!this.#recovery) {
      this.#protocolFailure("unexpected_replay_page");
      return;
    }
    try {
      this.#recovery = acceptReplayPage(this.#recovery, frame);
      for (const event of frame.events) {
        await this.#applyEvent(event);
      }
      this.#acknowledgeRecovery(frame.recoveryId);
    } catch (error) {
      this.#recoverFromValidation(error);
    }
  }

  async #handleRecoveryComplete(frame: RecoveryCompleteFrame): Promise<void> {
    if (!this.#recovery || !this.#canonical) {
      this.#protocolFailure("unexpected_recovery_complete");
      return;
    }
    try {
      completeRecovery(this.#recovery, frame, this.#canonical);
      this.#recovery = null;
      this.#connection = reduceConnection(this.#connection, { type: "recovered" });
      this.#trace("recovery", "complete", { revision: this.#canonical.revision });
      this.#emit();
      this.#startHeartbeat();
      this.#flushPending();
    } catch (error) {
      this.#recoverFromValidation(error);
    }
  }

  async #applyEvent(event: ControlEvent, acknowledgeDelivery = false): Promise<void> {
    if (!this.#canonical) {
      throw new RecoveryValidationError("received an event without a canonical replica");
    }
    if (event.revision <= this.#canonical.revision) {
      await this.#applyDuplicateEvent(event, acknowledgeDelivery);
      return;
    }
    await this.#applyNewEvent(event, acknowledgeDelivery);
  }

  async #applyDuplicateEvent(event: ControlEvent, acknowledgeDelivery: boolean): Promise<void> {
    if (!this.#canonical || !this.#matchesCanonicalHead(event)) {
      throw new RecoveryValidationError("duplicate event does not match the canonical head");
    }
    await this.#reconcileEvent(event);
    if (acknowledgeDelivery) {
      this.#acknowledgeLiveDelivery();
    }
    this.#emit();
  }

  async #applyNewEvent(event: ControlEvent, acknowledgeDelivery: boolean): Promise<void> {
    const canonical = requireCanonical(this.#canonical);
    const reduced = await reduceCanonicalEvent(canonical, event);
    await this.#commitEvent(event, requireReducedCanonical(reduced), acknowledgeDelivery);
  }

  #matchesCanonicalHead(event: ControlEvent): boolean {
    const canonical = this.#canonical;
    return canonical !== null && event.revision === canonical.revision && event.resultingStateDigest === canonical.stateDigest;
  }

  async #commitEvent(event: ControlEvent, canonical: CanonicalReplica, acknowledgeDelivery: boolean): Promise<void> {
    this.#canonical = canonical;
    await this.#reconcileEvent(event);
    if (acknowledgeDelivery) {
      this.#acknowledgeLiveDelivery();
    }
    if (canonical.state.status === "ended") {
      this.#connection = reduceConnection(this.#connection, { type: "ended" });
      this.#closeSocket(1000, "session ended");
    }
    this.#emit();
  }

  #acknowledgeLiveDelivery(): void {
    const canonical = this.#canonical;
    if (!canonical || this.#connection.phase !== "live") {
      return;
    }
    this.#sendFrame({ type: "delivery_ack", stream: "control", revision: canonical.revision, stateDigest: canonical.stateDigest });
    this.#trace("connection", "delivery_acknowledged", { revision: canonical.revision });
  }

  #acknowledgeRecovery(recoveryId: string): void {
    const canonical = this.#canonical;
    if (!canonical || this.#connection.phase !== "recovering") {
      return;
    }
    this.#sendFrame({
      type: "recovery_ack",
      recoveryId,
      revision: canonical.revision,
      stateDigest: canonical.stateDigest,
    });
    this.#trace("recovery", "recovery_acknowledged", { revision: canonical.revision });
  }

  async #reconcileEvent(event: ControlEvent): Promise<void> {
    if (!event.commandId) {
      return;
    }
    const acknowledgement = this.#acknowledged.get(event.commandId);
    if (acknowledgement) {
      if (!sameAcknowledgement(acknowledgement, event)) {
        throw new RecoveryValidationError("ACK and event disagree about a command result");
      }
      await this.#settleEventCommand(event);
      return;
    }
    if (this.#pending.has(event.commandId)) {
      await this.#settleEventCommand(event);
    }
  }

  async #settleEventCommand(event: ControlEvent): Promise<void> {
    if (!event.commandId) {
      return;
    }
    this.#acknowledged.delete(event.commandId);
    this.#recordSettled(event.commandId, { type: "ack", commandId: event.commandId, result: "committed", eventId: event.eventId, revision: event.revision });
    await this.#removePending(event.commandId);
  }

  async #handleAck(frame: AckFrame): Promise<void> {
    if (frame.result === "rejected") {
      await this.#handleRejectedAck(frame);
      return;
    }
    await this.#handleCommittedAck(frame);
  }

  async #handleRejectedAck(frame: RejectedAck): Promise<void> {
    if (!this.#pending.has(frame.commandId)) {
      return;
    }
    await this.#removePending(frame.commandId);
    this.#recordFailure({ commandId: frame.commandId, kind: "terminal_rejection", reason: frame.reason, at: this.#clock.now() });
    this.#trace("command", "terminal_rejection", { code: frame.reason });
    this.#emit();
  }

  async #handleCommittedAck(frame: CommittedAck): Promise<void> {
    const settled = this.#settled.get(frame.commandId);
    if (settled) {
      if (this.#validateSettledAck(settled, frame)) {
        await this.#removePending(frame.commandId);
        this.#emit();
      }
      return;
    }
    if (!this.#pending.has(frame.commandId)) {
      this.#trace("command", "unmatched_ack", {});
      return;
    }
    await this.#applyPendingAcknowledgement(frame);
  }

  async #applyPendingAcknowledgement(frame: CommittedAck): Promise<void> {
    if (!canonicalIncludesRevision(this.#canonical, frame.revision)) {
      this.#rememberAcknowledgement(frame);
      return;
    }
    this.#recordSettled(frame.commandId, frame);
    await this.#removePending(frame.commandId);
    this.#trace("command", "acknowledged_by_canonical_head", { revision: frame.revision });
    this.#emit();
  }

  #validateSettledAck(settled: CommittedAck, frame: CommittedAck): boolean {
    if (settled.eventId !== frame.eventId || settled.revision !== frame.revision) {
      this.#recoverFromValidation(new RecoveryValidationError("ACK conflicts with a settled command"));
      return false;
    }
    return true;
  }

  #rememberAcknowledgement(frame: CommittedAck): void {
    const existing = this.#acknowledged.get(frame.commandId);
    if (existing && !sameAcknowledgement(existing, frame)) {
      this.#recoverFromValidation(new RecoveryValidationError("conflicting ACK for a command"));
      return;
    }
    this.#acknowledged.set(frame.commandId, frame);
    this.#trace("command", "acknowledged", { revision: frame.revision });
  }

  #sendPending(pending: PendingCommand): void {
    if (this.#connection.phase !== "live" || this.#acknowledged.has(pending.commandId)) {
      return;
    }
    this.#sendFrame({ type: "command", commandId: pending.commandId, name: pending.command.name, ...(pending.command.payload ? { payload: pending.command.payload } : {}) });
  }

  #flushPending(): void {
    for (const pending of this.#pending.values()) {
      this.#sendPending(pending);
    }
  }

  async #removePending(commandId: string): Promise<void> {
    if (!this.#pending.has(commandId)) {
      return;
    }
    try {
      await this.#store.remove(commandId);
      this.#pending.delete(commandId);
    } catch {
      this.#trace("persistence", "remove_failed", {});
    }
  }

  async #loadPending(): Promise<void> {
    if (this.#loaded) {
      return;
    }
    if (this.#pendingLoad) {
      await this.#pendingLoad;
      return;
    }
    const load = this.#loadPendingFromStore();
    this.#pendingLoad = load;
    try {
      await load;
    } finally {
      this.#pendingLoad = undefined;
    }
  }

  async #loadPendingFromStore(): Promise<void> {
    const commands = await this.#store.load();
    for (const command of [...commands].sort(comparePending)) {
      this.#loadStoredPending(command);
    }
    this.#expirePending();
    this.#loaded = true;
    this.#emit();
  }

  #loadStoredPending(command: PendingCommand): void {
    if (!isStoredPending(command)) {
      this.#trace("persistence", "invalid_pending_record", {});
      return;
    }
    try {
      validateCommand(command.command);
      const normalized = { ...command, bytes: pendingCommandBytes(command.commandId, command.command) };
      if (!this.#hasPendingCapacity(normalized)) {
        this.#discardOverCapacityPending(normalized);
        return;
      }
      this.#pending.set(command.commandId, normalized);
    } catch {
      this.#trace("persistence", "invalid_pending_record", {});
    }
  }

  #hasPendingCapacity(command: PendingCommand): boolean {
    return this.#pending.size < this.#limits.maxPendingCommands && this.#pendingBytes() + command.bytes <= this.#limits.maxPendingBytes;
  }

  #discardOverCapacityPending(command: PendingCommand): void {
    this.#recordFailure({ commandId: command.commandId, kind: "capacity", reason: "pending_store_capacity_exceeded", at: this.#clock.now() });
    void this.#store.remove(command.commandId).catch(() => this.#trace("persistence", "capacity_remove_failed", {}));
  }

  #expirePending(): void {
    const now = this.#clock.now();
    for (const command of this.#pending.values()) {
      if (now - command.createdAt <= this.#limits.maxPendingAgeMs) {
        continue;
      }
      this.#pending.delete(command.commandId);
      void this.#store.remove(command.commandId).catch(() => this.#trace("persistence", "expire_remove_failed", {}));
      this.#recordFailure({ commandId: command.commandId, kind: "expired", reason: "pending_command_expired", at: now });
    }
  }

  #onLifecycle(event: SyncLifecycleEvent): void {
    const [signal, value] = lifecycleSignals[event];
    if (signal === "online") {
      this.#online = value;
    } else {
      this.#active = value;
    }
    const wasAvailable = this.#transportAvailable;
    this.#transportAvailable = this.#online && this.#active;
    if (!this.#transportAvailable) {
      this.#pauseForLifecycle();
      return;
    }
    this.#resumeForLifecycle(wasAvailable);
  }

  #pauseForLifecycle(): void {
    this.#closeSocket(1001, "lifecycle unavailable");
    this.#clearHeartbeatTimer();
  }

  #resumeForLifecycle(wasAvailable: boolean): void {
    if (!wasAvailable && this.#started) {
      this.#scheduleRetry("lifecycle_available", 0);
    }
  }

  #onSocketClose(socket: SyncSocket, code: number): void {
    if (socket !== this.#socket) {
      return;
    }
    this.#socket = null;
    this.#clearHeartbeatTimer();
    if (code === 1008) {
      this.#connection = reduceConnection(this.#connection, { type: "rejoin_required" });
      this.#emit();
      return;
    }
    this.#scheduleRetry("socket_closed");
  }

  #scheduleRetry(reason: string, delayOverride?: number): void {
    if (!this.#canScheduleRetry()) {
      return;
    }
    this.#closeSocket(1012, "reconnecting");
    const attempt = "attempt" in this.#connection ? Math.max(1, this.#connection.attempt) : 1;
    const delay = retryDelay(this.#connection, this.#random, this.#backoff, delayOverride);
    this.#connection = reduceConnection(this.#connection, { type: "retry", retryAt: this.#clock.now() + delay });
    this.#trace("connection", reason, { attempt, delay });
    this.#emit();
    this.#clearRetryTimer();
    if (this.options.clock) {
      this.#retryTimer = this.#clock.setTimeout(() => this.#connect(), delay);
    } else {
      this.#retryFiber = Effect.runFork(Effect.sleep(delay).pipe(Effect.andThen(Effect.sync(() => this.#connect()))));
    }
  }

  #canScheduleRetry(): boolean {
    if (!this.#started) {
      return false;
    }
    if (!this.#transportAvailable) {
      return false;
    }
    return this.#connection.phase !== "ended" && this.#connection.phase !== "stopped";
  }

  #recoverFromValidation(error: unknown): void {
    const code = error instanceof RecoveryValidationError ? "recovery_validation_failed" : "recovery_failed";
    this.#trace("recovery", code, {});
    this.#scheduleRetry(code, 0);
  }

  protocolFailure(code: string): void {
    this.#protocolFailure(code);
  }

  #protocolFailure(code: string): void {
    this.#trace("protocol", code, {});
    this.#connection = reduceConnection(this.#connection, { type: "protocol_error" });
    this.#closeSocket(1002, "protocol error");
    this.#emit();
  }

  #sendFrame(frame: ClientFrame): void {
    try {
      this.#socket?.send(this.#codec.encodeClient(frame));
    } catch {
      this.#scheduleRetry("send_failed");
    }
  }

  #startHeartbeat(): void {
    this.#clearHeartbeatTimer();
    if (this.options.clock) {
      this.#heartbeatTimer = this.#clock.setTimeout(() => {
        if (this.#connection.phase === "live") {
          this.#sendFrame({ type: "ping" });
          this.#startHeartbeat();
        }
      }, HEARTBEAT_MS);
    } else {
      this.#heartbeatFiber = Effect.runFork(Effect.sleep(HEARTBEAT_MS).pipe(Effect.andThen(Effect.sync(() => this.#sendFrame({ type: "ping" }))), Effect.repeat(Schedule.spaced(HEARTBEAT_MS))));
    }
  }

  #closeSocket(code: number, reason: string): void {
    const socket = this.#socket;
    this.#socket = null;
    this.#clearConnectionFiber();
    socket?.close(code, reason);
  }

  #isCurrentSocket(socket: SyncSocket): boolean {
    return this.#started && this.#socket === socket;
  }

  #pendingBytes(): number {
    return [...this.#pending.values()].reduce((total, pending) => total + pending.bytes, 0);
  }

  #recordFailure(failure: SyncCommandFailure): void {
    if (this.#failures.length === MAX_FAILURES) {
      this.#failures.shift();
    }
    this.#failures.push(failure);
  }

  #recordSettled(commandId: string, acknowledgement: CommittedAck): void {
    if (this.#settled.size === MAX_PENDING_COMMANDS) {
      const oldest = this.#settled.keys().next().value;
      if (oldest) {
        this.#settled.delete(oldest);
      }
    }
    this.#settled.set(commandId, acknowledgement);
  }

  #trace(kind: "connection" | "recovery" | "command" | "protocol" | "persistence", code: string, details: Record<string, boolean | number | string>): void {
    this.#diagnostics.add({ at: this.#clock.now(), kind, code, details });
  }

  #clearTimers(): void {
    this.#clearConnectionFiber();
    this.#clearRetryTimer();
    this.#clearHeartbeatTimer();
  }

  #clearConnectionFiber(): void {
    if (this.#connectionFiber) {
      this.#connectionFiber.interruptUnsafe();
      this.#connectionFiber = undefined;
    }
  }

  #clearRetryTimer(): void {
    if (this.#retryFiber) {
      this.#retryFiber.interruptUnsafe();
      this.#retryFiber = undefined;
    }
    if (this.#retryTimer !== undefined) {
      this.#clock.clearTimeout(this.#retryTimer);
      this.#retryTimer = undefined;
    }
  }

  #clearHeartbeatTimer(): void {
    if (this.#heartbeatFiber) {
      this.#heartbeatFiber.interruptUnsafe();
      this.#heartbeatFiber = undefined;
    }
    if (this.#heartbeatTimer !== undefined) {
      this.#clock.clearTimeout(this.#heartbeatTimer);
      this.#heartbeatTimer = undefined;
    }
  }

  #emit(): void {
    const snapshot = this.getSnapshot();
    if (this.#snapshotRef) {
      Effect.runSync(SubscriptionRef.set(this.#snapshotRef, snapshot));
    }
    for (const listener of this.#listeners) {
      listener(snapshot);
    }
  }
}

/**
 * Promise-and-synchronous compatibility facade. It deliberately owns the
 * runtime so applications never need to import Effect to use SyncClient.
 */
export class SyncClient {
  readonly #engine: SyncEngineEffectService;
  readonly #runtime: ManagedRuntime.ManagedRuntime<SyncEngineService, never>;

  constructor(readonly options: SyncClientOptions) {
    this.#runtime = ManagedRuntime.make(makeSyncEngineLayer(options));
    this.#engine = this.#runtime.runSync(Effect.service(SyncEngineService));
  }

  start(): Promise<void> {
    return this.#runtime.runPromise(this.#engine.start());
  }

  stop(): void {
    this.#runtime.runSync(this.#engine.stop());
  }

  refresh(): void {
    this.#runtime.runSync(this.#engine.refresh());
  }

  send(command: SyncCommand): Promise<string> {
    return this.#runtime.runPromise(this.#engine.send(command));
  }

  getSnapshot(): SyncSnapshot {
    return this.#engine.getSnapshot();
  }

  subscribe(listener: (snapshot: SyncSnapshot) => void): () => void {
    return this.#engine.subscribe(listener);
  }

  getDiagnostics(): SyncDiagnostics {
    return this.#engine.getDiagnostics();
  }
}

function effectClock(clock: Clock.Clock): SyncClock {
  return {
    now: () => clock.currentTimeMillisUnsafe(),
    setTimeout: (callback, milliseconds) => globalThis.setTimeout(callback, milliseconds),
    clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
  };
}

function effectIds(random: { readonly nextIntUnsafe: () => number }): SyncIdGenerator {
  return {
    next: () => Array.from({ length: 4 }, () => (random.nextIntUnsafe() >>> 0).toString(36).padStart(7, "0").slice(-7)).join(""),
  };
}
