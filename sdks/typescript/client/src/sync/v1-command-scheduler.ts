import type { SyncV1ClientFrame, SyncV1ServerFrame } from "../generated/sync";
import { encodeV1ClientFrame } from "./v1-codec";
import { rejectV1Deferred, resolveV1Deferred, type V1Deferred } from "./v1-deferred";
import { V1SyncError } from "./v1-error";
import { compareV1PendingTargets } from "./v1-persistence";
import { V1ReplicaError } from "./v1-reducer";
import { V1TimerMap } from "./v1-timer-map";
import type { V1CommandResult, V1OperationName, V1PendingTarget, V1PendingTargetStore, V1SyncClientOptions, V1TargetCommand } from "./v1-types";

const MAX_IN_FLIGHT = 256;
const MAX_PENDING_BYTES = 1024 * 1024;
const MAX_PENDING_AGE_MS = 24 * 60 * 60 * 1000;
const MAX_RETRIES = 3;
const OPERATION_PENDING_POLL_INTERVAL_MS = 1_000;

type CommandDeferred = V1Deferred<V1CommandResult> & {
  readonly frame: SyncV1ClientFrame;
  retries: number;
  readonly durableTarget: boolean;
  readonly createdAt: number;
};

type V1CommandOptions = { readonly commandId?: string };
type V1OperationFrame = Extract<SyncV1ClientFrame, { readonly type: "operation" }>;
export type V1OperationFrameFactory = (commandId: string) => V1OperationFrame;

type V1CommandSchedulerOptions = {
  readonly store: V1PendingTargetStore;
  readonly ids: V1SyncClientOptions["ids"];
  readonly maxPendingCommands: number | undefined;
  readonly maxPendingBytes: number | undefined;
  readonly maxPendingAgeMs: number | undefined;
  readonly maxOperationPendingAgeMs: number | undefined;
  readonly retryDelayMs: number | undefined;
  readonly clock: () => NonNullable<V1SyncClientOptions["clock"]>;
  readonly isStarted: () => boolean;
  readonly sendIfLive: (frame: SyncV1ClientFrame) => void;
  readonly stateChanged: () => void;
  readonly ackHeadIsProven: (ack: Extract<V1CommandResult, { readonly outcome: "committed" | "satisfied" }>) => boolean;
  readonly controlHead: () => { readonly revision: number; readonly state_digest: string };
};

export class V1CommandScheduler {
  readonly #options: V1CommandSchedulerOptions;
  readonly #pendingTargets = new Map<string, V1PendingTarget>();
  readonly #reservedCommandIds = new Set<string>();
  readonly #commands = new Map<string, CommandDeferred>();
  readonly #acknowledgements = new Map<string, Extract<V1CommandResult, { readonly outcome: "committed" | "satisfied" }>>();
  readonly #pendingRemovals = new Map<string, V1PendingTarget>();
  readonly #commandRetryTimers: V1TimerMap;
  readonly #pendingRemovalRetryTimers: V1TimerMap;
  #stopGeneration = 0;

  constructor(options: V1CommandSchedulerOptions) {
    this.#options = options;
    this.#commandRetryTimers = new V1TimerMap(options.clock);
    this.#pendingRemovalRetryTimers = new V1TimerMap(options.clock);
  }

  get pendingCount(): number {
    return this.#pendingTargets.size;
  }

  get inFlightCount(): number {
    return this.#commands.size + this.#pendingRemovals.size + this.#reservedCommandIds.size;
  }

  get pendingCommands(): readonly V1TargetCommand[] {
    return [...this.#pendingTargets.values()].sort(compareV1PendingTargets).map((pending) => pending.command);
  }

  load(): Promise<readonly V1PendingTarget[]> {
    return this.#options.store.load();
  }

  reconcileStored(stored: readonly V1PendingTarget[]): void {
    const storedCommandIds = new Set(stored.map((pending) => pending.commandId));
    for (const commandId of this.#pendingTargets.keys()) {
      if (storedCommandIds.has(commandId) || this.#commands.has(commandId)) continue;
      this.#pendingTargets.delete(commandId);
    }
    for (const commandId of this.#pendingRemovals.keys()) {
      if (storedCommandIds.has(commandId)) continue;
      this.#pendingRemovals.delete(commandId);
      this.#pendingRemovalRetryTimers.cancel(commandId);
    }
    for (const pending of [...stored].sort(compareV1PendingTargets)) {
      if (this.#pendingRemovals.has(pending.commandId)) {
        void this.#removePersistedTarget(pending.commandId, pending);
      } else if (this.#commands.has(pending.commandId)) {
        this.#pendingTargets.set(pending.commandId, pending);
      } else {
        this.#pendingTargets.delete(pending.commandId);
        this.#restorePending(pending);
      }
    }
  }

  stop(code: string): void {
    this.#stopGeneration += 1;
    this.#commandRetryTimers.cancelAll();
    this.#pendingRemovalRetryTimers.cancelAll();
    for (const deferred of this.#commands.values()) rejectV1Deferred(deferred, new V1SyncError(code, code));
    this.#commands.clear();
    this.#acknowledgements.clear();
  }

  disconnect(): void {
    this.#commandRetryTimers.cancelAll();
  }

  assertCapacity(externalInFlight: number): void {
    if (this.inFlightCount + externalInFlight >= this.#maxPending()) throw new V1SyncError("in-flight request capacity exceeded", "capacity");
  }

  async sendTarget(command: V1TargetCommand, externalInFlight: number, options?: V1CommandOptions): Promise<V1CommandResult> {
    this.assertCapacity(externalInFlight);
    const commandId = options?.commandId ?? this.#nextCommandId();
    this.#assertCommandIdAvailable(commandId);
    const frame = targetFrame(commandId, command);
    encodeV1ClientFrame(frame);
    const pending = { commandId, command, createdAt: this.#now(), bytes: new TextEncoder().encode(JSON.stringify(frame)).byteLength };
    if (this.#pendingBytes() + pending.bytes > (this.#options.maxPendingBytes ?? MAX_PENDING_BYTES)) throw new V1SyncError("pending target byte capacity exceeded", "capacity");
    this.#reservedCommandIds.add(commandId);
    const stopGeneration = this.#stopGeneration;
    try {
      await this.#options.store.put(pending);
      if (stopGeneration !== this.#stopGeneration) {
        this.#pendingTargets.set(commandId, pending);
        this.#commands.set(commandId, { resolve: () => undefined, reject: () => undefined, settled: true, frame, retries: 0, durableTarget: true, createdAt: pending.createdAt });
        this.#options.sendIfLive(frame);
        this.#options.stateChanged();
        throw new V1SyncError("client_stopped", "client_stopped");
      }
      this.#pendingTargets.set(commandId, pending);
      const promise = this.#registerCommand(commandId, frame, true, pending.createdAt);
      this.#options.sendIfLive(frame);
      this.#options.stateChanged();
      return promise;
    } finally {
      this.#reservedCommandIds.delete(commandId);
    }
  }

  sendOperation(createFrame: V1OperationFrameFactory, externalInFlight: number, options?: V1CommandOptions): Promise<V1CommandResult> {
    this.assertCapacity(externalInFlight);
    const commandId = options?.commandId ?? this.#nextCommandId();
    this.#assertCommandIdAvailable(commandId);
    const frame = createFrame(commandId);
    encodeV1ClientFrame(frame);
    const promise = this.#registerCommand(commandId, frame, false, this.#now());
    this.#options.sendIfLive(frame);
    return promise;
  }

  async acknowledge(frame: V1CommandResult): Promise<void> {
    const deferred = this.#commands.get(frame.command_id);
    if (!deferred) return;
    if (isSatisfiedByInactiveParticipant(frame, deferred.frame)) {
      const head = this.#options.controlHead();
      await this.#finishCommand(frame.command_id, satisfiedAck(frame.command_id, head.revision, head.state_digest));
      return;
    }
    if (frame.outcome === "rejected" || frame.outcome === "command_id_conflict") {
      await this.#finishCommand(frame.command_id, frame);
      return;
    }
    if (isTerminalLifecycleOperation(deferred.frame)) {
      await this.#finishCommand(frame.command_id, frame);
      return;
    }
    if (!this.#options.ackHeadIsProven(frame)) {
      const previous = this.#acknowledgements.get(frame.command_id);
      if (previous && JSON.stringify(previous) !== JSON.stringify(frame)) throw new V1ReplicaError("conflicting duplicate command ACK");
      this.#acknowledgements.set(frame.command_id, frame);
      return;
    }
    await this.#finishCommand(frame.command_id, frame);
  }

  async settleProven(): Promise<void> {
    for (const commandId of this.#commands.keys()) {
      const ack = this.#acknowledgements.get(commandId);
      if (ack && this.#options.ackHeadIsProven(ack)) await this.#finishCommand(commandId, ack);
    }
  }

  async settleTerminalLifecycle(frame: Extract<SyncV1ServerFrame, { readonly type: "event" }>, participantId: string | null): Promise<void> {
    const operationName = frame.name === "episode_ended" ? "end_episode" : frame.name === "participant_left" && frame.payload.participant_id === participantId ? "participant_leave" : null;
    if (!operationName) return;
    for (const [commandId, deferred] of this.#commands) {
      if (deferred.frame.type !== "operation" || deferred.frame.name !== operationName) continue;
      await this.#finishCommand(commandId, satisfiedAck(commandId, frame.revision, frame.resulting_state_digest));
    }
  }

  async settleTerminalRecovery(frame: Extract<SyncV1ServerFrame, { readonly type: "welcome"; readonly mode: "terminal" }>): Promise<void> {
    const satisfies = (operation: V1OperationName): boolean => {
      if (frame.reason === "episode_ended") return operation === "end_episode" || operation === "participant_leave";
      return frame.reason === "participant_inactive" && operation === "participant_leave";
    };
    for (const [commandId, deferred] of this.#commands) {
      if (deferred.frame.type !== "operation" || !satisfies(deferred.frame.name)) continue;
      await this.#finishCommand(commandId, satisfiedAck(commandId, frame.head.revision, frame.head.state_digest));
    }
  }

  retry(commandId: string, code: Extract<SyncV1ServerFrame, { readonly type: "retryable_error" }>["code"]): void {
    const deferred = this.#commands.get(commandId);
    if (!deferred || this.#commandRetryTimers.has(commandId)) return;
    if (code === "external_operation_pending") {
      this.#pollPendingOperation(commandId, deferred);
      return;
    }
    if (deferred.retries >= MAX_RETRIES) {
      rejectV1Deferred(deferred, new V1SyncError(code, "retry_exhausted"));
      if (!deferred.durableTarget) this.#commands.delete(commandId);
      return;
    }
    deferred.retries += 1;
    this.#commandRetryTimers.schedule(
      commandId,
      () => {
        if (this.#commands.get(commandId) === deferred) this.#options.sendIfLive(deferred.frame);
      },
      this.#options.retryDelayMs ?? 100,
    );
  }

  enterLive(): void {
    for (const pending of this.#commands.values()) {
      pending.retries = 0;
      this.#options.sendIfLive(pending.frame);
    }
  }

  #registerCommand(commandId: string, frame: SyncV1ClientFrame, durableTarget: boolean, createdAt: number): Promise<V1CommandResult> {
    if (this.#commands.has(commandId)) throw new V1SyncError("command ID is already pending", "command_id_conflict");
    return new Promise((resolve, reject) => this.#commands.set(commandId, { resolve, reject, settled: false, frame, retries: 0, durableTarget, createdAt }));
  }

  #pollPendingOperation(commandId: string, deferred: CommandDeferred): void {
    const remainingAge = (this.#options.maxOperationPendingAgeMs ?? MAX_PENDING_AGE_MS) - (this.#now() - deferred.createdAt);
    if (remainingAge <= 0) {
      this.#expirePendingOperation(commandId, deferred);
      return;
    }
    this.#commandRetryTimers.schedule(
      commandId,
      () => {
        if (this.#commands.get(commandId) !== deferred) return;
        if (this.#now() - deferred.createdAt >= (this.#options.maxOperationPendingAgeMs ?? MAX_PENDING_AGE_MS)) {
          this.#expirePendingOperation(commandId, deferred);
          return;
        }
        this.#options.sendIfLive(deferred.frame);
      },
      Math.min(OPERATION_PENDING_POLL_INTERVAL_MS, remainingAge),
    );
  }

  #expirePendingOperation(commandId: string, deferred: CommandDeferred): void {
    if (this.#commands.get(commandId) !== deferred) return;
    const pending = this.#detachCommand(commandId, deferred);
    rejectV1Deferred(deferred, new V1SyncError("external operation remained pending beyond its maximum age", "operation_pending_timeout"));
    this.#options.stateChanged();
    if (pending) void this.#removePersistedTarget(commandId, pending);
  }

  /** Stops tracking a command. A durable target moves to the removals awaiting its store delete. */
  #detachCommand(commandId: string, deferred: CommandDeferred): V1PendingTarget | undefined {
    this.#commands.delete(commandId);
    this.#commandRetryTimers.cancel(commandId);
    this.#acknowledgements.delete(commandId);
    if (!deferred.durableTarget) return undefined;
    const pending = this.#pendingTargets.get(commandId);
    this.#pendingTargets.delete(commandId);
    if (pending) this.#pendingRemovals.set(commandId, pending);
    return pending;
  }

  async #finishCommand(commandId: string, result: V1CommandResult): Promise<void> {
    const deferred = this.#commands.get(commandId);
    if (!deferred) return;
    const pending = this.#detachCommand(commandId, deferred);
    if (result.outcome === "rejected" || result.outcome === "command_id_conflict") rejectV1Deferred(deferred, new V1SyncError(result.reason, result.outcome));
    else resolveV1Deferred(deferred, result);
    this.#options.stateChanged();
    if (pending) void this.#removePersistedTarget(commandId, pending);
  }

  #restorePending(pending: V1PendingTarget): void {
    if (this.#pendingTargets.size + this.#pendingRemovals.size >= this.#maxPending() || this.#now() - pending.createdAt > (this.#options.maxPendingAgeMs ?? MAX_PENDING_AGE_MS) || this.#pendingBytes() + pending.bytes > (this.#options.maxPendingBytes ?? MAX_PENDING_BYTES)) {
      void this.#removePersistedTarget(pending.commandId, pending);
      return;
    }
    const frame = targetFrame(pending.commandId, pending.command);
    encodeV1ClientFrame(frame);
    this.#pendingTargets.set(pending.commandId, pending);
    this.#commands.set(pending.commandId, { resolve: () => undefined, reject: () => undefined, settled: true, frame, retries: 0, durableTarget: true, createdAt: pending.createdAt });
  }

  async #removePersistedTarget(commandId: string, pending: V1PendingTarget): Promise<void> {
    this.#pendingRemovals.set(commandId, pending);
    try {
      await this.#options.store.remove(commandId);
      if (this.#pendingRemovals.get(commandId) !== pending) return;
      this.#pendingRemovals.delete(commandId);
      this.#pendingRemovalRetryTimers.cancel(commandId);
    } catch {
      if (this.#pendingRemovals.get(commandId) !== pending) return;
      this.#schedulePendingRemovalRetry(commandId, pending);
    }
  }

  #schedulePendingRemovalRetry(commandId: string, pending: V1PendingTarget): void {
    if (!this.#options.isStarted() || this.#pendingRemovalRetryTimers.has(commandId)) return;
    this.#pendingRemovalRetryTimers.schedule(commandId, () => void this.#removePersistedTarget(commandId, pending), this.#options.retryDelayMs ?? 100);
  }

  #assertCommandIdAvailable(commandId: string): void {
    if (this.#commands.has(commandId) || this.#pendingTargets.has(commandId) || this.#pendingRemovals.has(commandId) || this.#reservedCommandIds.has(commandId)) throw new V1SyncError("command ID is already pending", "command_id_conflict");
  }

  #pendingBytes(): number {
    return [...this.#pendingTargets.values(), ...this.#pendingRemovals.values()].reduce((total, pending) => total + pending.bytes, 0);
  }

  #maxPending(): number {
    return Math.min(this.#options.maxPendingCommands ?? MAX_IN_FLIGHT, MAX_IN_FLIGHT);
  }

  #nextCommandId(): string {
    return this.#options.ids?.next() ?? crypto.randomUUID();
  }

  #now(): number {
    return this.#options.clock().now();
  }
}

function targetFrame(commandId: string, command: V1TargetCommand): Extract<SyncV1ClientFrame, { readonly type: "command" }> {
  switch (command.name) {
    case "set_hand_raised":
      return { type: "command", command_id: commandId, name: command.name, payload: command.payload };
    case "set_display_name":
      return { type: "command", command_id: commandId, name: command.name, payload: command.payload };
    case "set_admission_policy":
      return { type: "command", command_id: commandId, name: command.name, payload: command.payload };
    case "assign_roles":
      return { type: "command", command_id: commandId, name: command.name, payload: command.payload };
  }
}

function satisfiedAck(commandId: string, revision: number, stateDigest: string): V1CommandResult {
  return { type: "ack", command_id: commandId, delivery: "duplicate", outcome: "satisfied", revision, state_digest: stateDigest };
}

// A Participant that is already inactive has reached the state a Leave asks for, whether sync reports it live or in a terminal recovery.
function isSatisfiedByInactiveParticipant(result: V1CommandResult, command: SyncV1ClientFrame): boolean {
  return result.outcome === "rejected" && result.reason === "participant_inactive" && command.type === "operation" && command.name === "participant_leave";
}

function isTerminalLifecycleOperation(frame: SyncV1ClientFrame): boolean {
  return frame.type === "operation" && (frame.name === "participant_leave" || frame.name === "end_episode");
}
