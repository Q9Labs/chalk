import { reduceConnection, retryDelay, type SyncBackoffOptions } from "./connection";
import { copyReplica, optimisticSnapshotState, pendingCommandBytes, reduceCanonicalEvent, restoreSnapshot } from "./client-state";
import { SyncDiagnosticBuffer, type SyncDiagnostics } from "./diagnostics";
import { SyncCapacityError, SyncCommandValidationError, SyncPersistenceError } from "./errors";
import { InMemoryPendingCommandStore, type PendingCommandStore } from "./persistence";
import { beginRecovery, acceptReplayPage, completeRecovery, MAX_INBOUND_SERVER_FRAME_BYTES, type RecoveryPlan, RecoveryValidationError } from "./recovery";
import type { SyncProtocolCodec } from "./protocol";
import type {
  AckFrame,
  CanonicalReplica,
  ClientFrame,
  ControlEvent,
  PendingCommand,
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
const MAX_PENDING_COMMANDS = 256;
const MAX_PENDING_BYTES = 1024 * 1024;
const MAX_PENDING_AGE_MS = 24 * 60 * 60 * 1000;
const MAX_FAILURES = 32;
const HEARTBEAT_MS = 20_000;

type SyncClientLimits = Required<NonNullable<SyncClientOptions["limits"]>>;

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

export class SyncClient {
  readonly #store: PendingCommandStore;
  readonly #clock: SyncClock;
  readonly #random: SyncRandom;
  readonly #ids: SyncIdGenerator;
  readonly #codec: SyncProtocolCodec;
  readonly #diagnostics: SyncDiagnosticBuffer;
  readonly #limits: SyncClientLimits;
  readonly #backoff: SyncBackoffOptions;
  readonly #listeners = new Set<(snapshot: SyncSnapshot) => void>();
  readonly #pending = new Map<string, PendingCommand>();
  readonly #acknowledged = new Map<string, Extract<AckFrame, { readonly result: "committed" | "duplicate" }>>();
  readonly #settled = new Map<string, Extract<AckFrame, { readonly result: "committed" | "duplicate" }>>();
  readonly #failures: SyncCommandFailure[] = [];
  readonly #lifecycle?: SyncLifecycle;
  #connection: SyncConnectionState = { phase: "idle" };
  #canonical: CanonicalReplica | null = null;
  #participantSessionId: string | null = null;
  #socket: SyncSocket | null = null;
  #socketGeneration = 0;
  #recovery: RecoveryPlan | null = null;
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
  #inbound = Promise.resolve();

  constructor(readonly options: SyncClientOptions) {
    this.#store = pendingStoreFrom(options);
    this.#clock = clockFrom(options);
    this.#random = randomFrom(options);
    this.#ids = idGeneratorFrom(options);
    this.#codec = options.codec;
    this.#diagnostics = new SyncDiagnosticBuffer(options.diagnosticsCapacity);
    this.#limits = pendingLimitsFrom(options);
    this.#backoff = options.backoff ?? {};
    this.#lifecycle = options.lifecycle;
    validateLimits(this.#limits);
  }

  async start(): Promise<void> {
    if (this.#started) {
      return;
    }
    const startGeneration = ++this.#startGeneration;
    this.#beginStart();
    await this.#loadPendingForStart(startGeneration);
    if (this.#isCurrentStart(startGeneration)) {
      this.#finishStart();
    }
  }

  async #loadPendingForStart(startGeneration: number): Promise<void> {
    try {
      await this.#loadPending();
    } catch {
      if (this.#isCurrentStart(startGeneration)) {
        this.#started = false;
      }
      throw new Error("unable to load pending sync commands");
    }
  }

  #beginStart(): void {
    this.#started = true;
    if (this.#connection.phase === "stopped" && this.#connection.reason === "stopped") {
      this.#connection = { phase: "idle" };
    }
  }

  #finishStart(): void {
    this.#unsubscribeLifecycle = this.#lifecycle?.subscribe((event) => this.#onLifecycle(event));
    if (this.#transportAvailable) {
      this.#connect();
    }
  }

  #isCurrentStart(startGeneration: number): boolean {
    return this.#started && this.#startGeneration === startGeneration;
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
    if (!this.#canRefresh()) {
      return;
    }
    this.#trace("connection", "refresh_requested", {});
    if (this.#resumeAfterRejoin()) {
      return;
    }
    this.#scheduleRetry("refresh", 0);
  }

  #canRefresh(): boolean {
    return this.#started && this.#connection.phase !== "ended" && (this.#connection.phase !== "stopped" || this.#connection.reason === "rejoin_required");
  }

  #resumeAfterRejoin(): boolean {
    if (this.#connection.phase !== "stopped") {
      return false;
    }
    this.#connection = { phase: "idle" };
    this.#connect();
    return true;
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
    const generation = ++this.#socketGeneration;
    try {
      const socket = this.options.webSocket.connect(this.options.url);
      this.#socket = socket;
      socket.onopen = () => void this.#onSocketOpen(generation);
      socket.onmessage = (event) => this.#enqueueInbound(generation, event.data);
      socket.onclose = (event) => this.#onSocketClose(generation, event.code);
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

  async #onSocketOpen(generation: number): Promise<void> {
    if (!this.#isCurrentSocket(generation)) {
      return;
    }
    this.#connection = reduceConnection(this.#connection, { type: "socket_open" });
    this.#emit();
    await this.#authenticateSocket(generation);
  }

  async #authenticateSocket(generation: number): Promise<void> {
    try {
      const token = await this.options.token();
      this.#finishAuthentication(generation, token);
    } catch {
      this.#scheduleRetry("authentication_failed");
    }
  }

  #finishAuthentication(generation: number, token: string): void {
    if (!this.#isCurrentSocket(generation)) {
      return;
    }
    this.#sendFrame(helloFrame(token, this.#canonical));
    this.#connection = reduceConnection(this.#connection, { type: "hello_sent" });
    this.#trace("connection", "hello_sent", { revision: canonicalRevision(this.#canonical) });
    this.#emit();
  }

  #enqueueInbound(generation: number, data: unknown): void {
    this.#inbound = this.#inbound.then(() => this.#handleInbound(generation, data)).catch(() => this.#protocolFailure("inbound_failure"));
  }

  async #handleInbound(generation: number, data: unknown): Promise<void> {
    if (!this.#isCurrentSocket(generation)) {
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
    const handlers: Record<ServerFrame["type"], () => Promise<void>> = {
      welcome: () => this.#handleWelcome(frame as WelcomeFrame),
      replay_page: () => this.#handleReplayPage(frame as Extract<ServerFrame, { readonly type: "replay_page" }>),
      recovery_complete: () => this.#handleRecoveryComplete(frame as Extract<ServerFrame, { readonly type: "recovery_complete" }>),
      event: () => this.#handleLiveEvent(frame as Extract<ServerFrame, { readonly type: "event" }>),
      ack: () => this.#handleAck(frame as AckFrame),
      retryable_error: () => this.#handleRetryableError(frame as Extract<ServerFrame, { readonly type: "retryable_error" }>),
      error: () => this.#handleServerError(frame as Extract<ServerFrame, { readonly type: "error" }>),
      pong: async () => undefined,
    };
    const handler = handlers[frame.type];
    if (!handler) {
      this.#protocolFailure("unknown_server_frame");
      return;
    }
    await handler();
  }

  async #handleLiveEvent(frame: Extract<ServerFrame, { readonly type: "event" }>): Promise<void> {
    if (this.#connection.phase !== "live") {
      this.#protocolFailure("event_before_live");
      return;
    }
    await this.#applyEvent(frame, true);
  }

  async #handleRetryableError(frame: Extract<ServerFrame, { readonly type: "retryable_error" }>): Promise<void> {
    this.#trace("command", "retryable_error", { code: frame.code, pending: this.#pending.size });
  }

  async #handleServerError(frame: Extract<ServerFrame, { readonly type: "error" }>): Promise<void> {
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

  async #handleReplayPage(frame: Extract<ServerFrame, { readonly type: "replay_page" }>): Promise<void> {
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

  async #handleRecoveryComplete(frame: Extract<ServerFrame, { readonly type: "recovery_complete" }>): Promise<void> {
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
    this.#acknowledgeIfRequested(acknowledgeDelivery);
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
    this.#acknowledgeIfRequested(acknowledgeDelivery);
    if (canonical.state.status === "ended") {
      this.#connection = reduceConnection(this.#connection, { type: "ended" });
      this.#closeSocket(1000, "session ended");
    }
    this.#emit();
  }

  #acknowledgeIfRequested(acknowledgeDelivery: boolean): void {
    if (acknowledgeDelivery) {
      this.#acknowledgeLiveDelivery();
    }
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
      this.#assertAcknowledgementMatchesEvent(acknowledgement, event);
      await this.#settleEventCommand(event);
      return;
    }
    if (this.#pending.has(event.commandId)) {
      await this.#settleEventCommand(event);
    }
  }

  #assertAcknowledgementMatchesEvent(acknowledgement: Extract<AckFrame, { readonly result: "committed" | "duplicate" }>, event: ControlEvent): void {
    if (!sameAcknowledgement(acknowledgement, event)) {
      throw new RecoveryValidationError("ACK and event disagree about a command result");
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

  async #handleRejectedAck(frame: Extract<AckFrame, { readonly result: "rejected" }>): Promise<void> {
    if (!this.#pending.has(frame.commandId)) {
      return;
    }
    await this.#removePending(frame.commandId);
    this.#recordFailure({ commandId: frame.commandId, kind: "terminal_rejection", reason: frame.reason, at: this.#clock.now() });
    this.#trace("command", "terminal_rejection", { code: frame.reason });
    this.#emit();
  }

  async #handleCommittedAck(frame: Extract<AckFrame, { readonly result: "committed" | "duplicate" }>): Promise<void> {
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

  async #applyPendingAcknowledgement(frame: Extract<AckFrame, { readonly result: "committed" | "duplicate" }>): Promise<void> {
    if (!canonicalIncludesRevision(this.#canonical, frame.revision)) {
      this.#rememberAcknowledgement(frame);
      return;
    }
    this.#recordSettled(frame.commandId, frame);
    await this.#removePending(frame.commandId);
    this.#trace("command", "acknowledged_by_canonical_head", { revision: frame.revision });
    this.#emit();
  }

  #validateSettledAck(settled: Extract<AckFrame, { readonly result: "committed" | "duplicate" }>, frame: Extract<AckFrame, { readonly result: "committed" | "duplicate" }>): boolean {
    if (settled.eventId !== frame.eventId || settled.revision !== frame.revision) {
      this.#recoverFromValidation(new RecoveryValidationError("ACK conflicts with a settled command"));
      return false;
    }
    return true;
  }

  #rememberAcknowledgement(frame: Extract<AckFrame, { readonly result: "committed" | "duplicate" }>): void {
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
    this.#setLifecycleSignal(signal, value);
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

  #setLifecycleSignal(signal: "online" | "active", value: boolean): void {
    if (signal === "online") {
      this.#online = value;
      return;
    }
    this.#active = value;
  }

  #onSocketClose(generation: number, code: number): void {
    if (generation !== this.#socketGeneration) {
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
    const attempt = this.#retryAttempt();
    const delay = retryDelay(this.#connection, this.#random, this.#backoff, delayOverride);
    this.#connection = reduceConnection(this.#connection, { type: "retry", retryAt: this.#clock.now() + delay });
    this.#trace("connection", reason, { attempt, delay });
    this.#emit();
    this.#clearRetryTimer();
    this.#retryTimer = this.#clock.setTimeout(() => this.#connect(), delay);
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

  #retryAttempt(): number {
    return "attempt" in this.#connection ? Math.max(1, this.#connection.attempt) : 1;
  }

  #recoverFromValidation(error: unknown): void {
    const code = error instanceof RecoveryValidationError ? "recovery_validation_failed" : "recovery_failed";
    this.#trace("recovery", code, {});
    this.#scheduleRetry(code, 0);
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
    this.#heartbeatTimer = this.#clock.setTimeout(() => {
      if (this.#connection.phase === "live") {
        this.#sendFrame({ type: "ping" });
        this.#startHeartbeat();
      }
    }, HEARTBEAT_MS);
  }

  #closeSocket(code: number, reason: string): void {
    const socket = this.#socket;
    this.#socket = null;
    this.#socketGeneration += 1;
    socket?.close(code, reason);
  }

  #isCurrentSocket(generation: number): boolean {
    return this.#started && generation === this.#socketGeneration && this.#socket !== null;
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

  #recordSettled(commandId: string, acknowledgement: Extract<AckFrame, { readonly result: "committed" | "duplicate" }>): void {
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
    this.#clearRetryTimer();
    this.#clearHeartbeatTimer();
  }

  #clearRetryTimer(): void {
    if (this.#retryTimer !== undefined) {
      this.#clock.clearTimeout(this.#retryTimer);
      this.#retryTimer = undefined;
    }
  }

  #clearHeartbeatTimer(): void {
    if (this.#heartbeatTimer !== undefined) {
      this.#clock.clearTimeout(this.#heartbeatTimer);
      this.#heartbeatTimer = undefined;
    }
  }

  #emit(): void {
    const snapshot = this.getSnapshot();
    for (const listener of this.#listeners) {
      listener(snapshot);
    }
  }
}

const systemClock: SyncClock = {
  now: () => Date.now(),
  setTimeout: (callback, milliseconds) => globalThis.setTimeout(callback, milliseconds),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
};

const browserIds: SyncIdGenerator = {
  next: () => globalThis.crypto.randomUUID(),
};

function pendingStoreFrom(options: SyncClientOptions): PendingCommandStore {
  return options.pendingStore ?? new InMemoryPendingCommandStore();
}

function clockFrom(options: SyncClientOptions): SyncClock {
  return options.clock ?? systemClock;
}

function randomFrom(options: SyncClientOptions): SyncRandom {
  return options.random ?? Math.random;
}

function idGeneratorFrom(options: SyncClientOptions): SyncIdGenerator {
  return options.ids ?? browserIds;
}

function pendingLimitsFrom(options: SyncClientOptions): SyncClientLimits {
  const limits = options.limits;
  if (!limits) {
    return defaultPendingLimits();
  }
  return {
    maxPendingCommands: limitOrDefault(limits.maxPendingCommands, MAX_PENDING_COMMANDS),
    maxPendingBytes: limitOrDefault(limits.maxPendingBytes, MAX_PENDING_BYTES),
    maxPendingAgeMs: limitOrDefault(limits.maxPendingAgeMs, MAX_PENDING_AGE_MS),
  };
}

function defaultPendingLimits(): SyncClientLimits {
  return { maxPendingCommands: MAX_PENDING_COMMANDS, maxPendingBytes: MAX_PENDING_BYTES, maxPendingAgeMs: MAX_PENDING_AGE_MS };
}

function limitOrDefault(value: number | undefined, fallback: number): number {
  return value ?? fallback;
}

function validateLimits(limits: SyncClientLimits): void {
  if (![limits.maxPendingCommands, limits.maxPendingBytes, limits.maxPendingAgeMs].every(isPositiveInteger)) {
    throw new RangeError("pending command limits must be positive");
  }
}

function validateCommand(command: SyncCommand): void {
  if (!isSupportedCommand(command)) {
    throw new SyncCommandValidationError("unsupported sync command");
  }
  try {
    pendingCommandBytes("validation-command-id", command);
  } catch {
    throw new SyncCommandValidationError("command payload must be canonical JSON");
  }
}

function isSupportedCommand(command: SyncCommand): boolean {
  if (command.name !== "raise_hand" && command.name !== "lower_hand") {
    return false;
  }
  return isEmptyCommandPayload(command.payload);
}

function isEmptyCommandPayload(payload: SyncCommand["payload"]): boolean {
  if (!payload) {
    return true;
  }
  if (!isRecord(payload)) {
    return false;
  }
  return Object.keys(payload).length === 0;
}

function isCommandId(value: string): boolean {
  return /^[A-Za-z0-9_-]{16,64}$/.test(value);
}

function isPositiveInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 1;
}

function isStoredPending(value: PendingCommand): boolean {
  return isCommandId(value.commandId) && Number.isFinite(value.createdAt) && Number.isInteger(value.bytes) && value.bytes > 0;
}

function isRecord(value: object): boolean {
  return Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null;
}

function comparePending(left: PendingCommand, right: PendingCommand): number {
  return left.createdAt - right.createdAt || (left.commandId < right.commandId ? -1 : left.commandId > right.commandId ? 1 : 0);
}

function headOf(replica: CanonicalReplica): { readonly revision: number; readonly stateSchemaVersion: number; readonly stateDigest: string } {
  return { revision: replica.revision, stateSchemaVersion: replica.stateSchemaVersion, stateDigest: replica.stateDigest };
}

function copyPending(pending: PendingCommand): PendingCommand {
  return { ...pending, command: { ...pending.command, ...(pending.command.payload ? { payload: { ...pending.command.payload } } : {}) } };
}

function helloFrame(token: string, canonical: CanonicalReplica | null): ClientFrame {
  const cursor = canonical ? headOf(canonical) : null;
  return { type: "hello", protocol: 2, token, streams: { control: { cursor } } };
}

function canonicalRevision(canonical: CanonicalReplica | null): number {
  return canonical ? canonical.revision : -1;
}

function requireSnapshot(frame: WelcomeFrame): NonNullable<WelcomeFrame["snapshot"]> {
  if (!frame.snapshot) {
    throw new RecoveryValidationError("snapshot welcome has no snapshot");
  }
  return frame.snapshot;
}

function requireRestoredCanonical(restored: Awaited<ReturnType<typeof restoreSnapshot>>): CanonicalReplica {
  if (restored.ok) {
    return restored.canonical;
  }
  if (restored.error === "invalid_state") {
    throw new RecoveryValidationError("snapshot contains an invalid durable state");
  }
  throw new RecoveryValidationError("snapshot digest does not match its state");
}

function requireCanonical(canonical: CanonicalReplica | null): CanonicalReplica {
  if (!canonical) {
    throw new RecoveryValidationError("received an event without a canonical replica");
  }
  return canonical;
}

function requireReducedCanonical(reduced: Awaited<ReturnType<typeof reduceCanonicalEvent>>): CanonicalReplica {
  if (reduced.ok) {
    return reduced.canonical;
  }
  if (reduced.error === "reducer") {
    throw new RecoveryValidationError(`control reducer rejected event: ${reduced.reducerError}`);
  }
  throw new RecoveryValidationError("event digest does not match reduced state");
}

function canonicalIncludesRevision(canonical: CanonicalReplica | null, revision: number): boolean {
  return canonical !== null && canonical.revision >= revision;
}

function sameAcknowledgement(left: Pick<Extract<AckFrame, { readonly result: "committed" | "duplicate" }>, "eventId" | "revision">, right: Pick<ControlEvent | Extract<AckFrame, { readonly result: "committed" | "duplicate" }>, "eventId" | "revision">): boolean {
  return left.eventId === right.eventId && left.revision === right.revision;
}
