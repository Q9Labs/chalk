import { SyncProtocolLimits, type SyncV3ClientFrame, type SyncV3ServerFrame } from "../generated/sync-v3";
import { canonicalJsonBytesFromUnknown } from "./canonical";
import { encodeV3ClientFrame, decodeV3ServerFrame } from "./v3-codec";
import { InMemoryV3PendingTargetStore, compareV3PendingTargets } from "./v3-persistence";
import { applyV3Event, optimisticV3Control, restoreV3Snapshot, V3ReplicaError } from "./v3-reducer";
import type {
  V3AdmissionPolicy,
  V3AssignableRole,
  V3CommandResult,
  V3ClientMediaPlane,
  V3ControlState,
  V3DirectedRequest,
  V3DirectedRequestResult,
  V3LiveTargetResult,
  V3MediaPublication,
  V3MediaPlaneResult,
  V3MediaSource,
  V3OperationName,
  V3PendingTarget,
  V3PendingTargetStore,
  V3Presence,
  V3Projection,
  V3SessionSnapshot,
  V3SelfMediaTargetResult,
  V3Socket,
  V3SyncClientOptions,
  V3TargetCommand,
} from "./v3-types";

const encoder = new TextEncoder();
const MAX_IN_FLIGHT = 256;
const MAX_PENDING_BYTES = 1024 * 1024;
const MAX_PENDING_AGE_MS = 24 * 60 * 60 * 1000;
const MAX_REPLAY_EVENTS = SyncProtocolLimits.completeReplayMaxEvents;
const MAX_REPLAY_BYTES = SyncProtocolLimits.completeReplayEncodedBytes;
const MAX_RETRIES = 3;
const MAX_PROJECTION_EVENT_EVIDENCE = 256;
const OPERATION_PENDING_POLL_INTERVAL_MS = 1_000;
const CLIENT_RESTART_CLOSE_CODE = 4000;

type CommandDeferred = Deferred<V3CommandResult> & { readonly frame: SyncV3ClientFrame; retries: number; readonly durableTarget: boolean; readonly createdAt: number };
type LiveTargetClientFrame = Extract<SyncV3ClientFrame, { readonly type: "live_target" }>;
type SuccessfulLiveTargetResult = Omit<V3LiveTargetResult, "outcome"> & { readonly outcome: "confirmed" | "satisfied" };
type LiveDeferred = Deferred<V3SelfMediaTargetResult> & {
  readonly frame: LiveTargetClientFrame;
  serverRetries: number;
  localRetries: number;
  localInFlight: boolean;
  readonly source: V3MediaSource;
  readonly enabled: boolean;
  serverResult?: SuccessfulLiveTargetResult;
  serverResultSignature?: string;
};
type RequestDeferred = Deferred<V3DirectedRequestResult> & { readonly frame: SyncV3ClientFrame };
type Deferred<T> = { readonly resolve: (value: T) => void; readonly reject: (error: Error) => void; settled: boolean };
type Recovery = { readonly id: string; readonly head: { readonly revision: number; readonly state_schema_version: number; readonly state_digest: string }; replayEvents: number; replayBytes: number; controlComplete: boolean };
type CommandOptions = { readonly commandId?: string };
type RequestOptions = { readonly requestId?: string };

export class V3SyncError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = "V3SyncError";
  }
}

export class V3SyncClient {
  readonly #options: V3SyncClientOptions;
  readonly #store: V3PendingTargetStore;
  readonly #listeners = new Set<(snapshot: V3SessionSnapshot) => void>();
  readonly #requestListeners = new Set<(request: V3DirectedRequest) => void>();
  readonly #pendingTargets = new Map<string, V3PendingTarget>();
  readonly #reservedCommandIds = new Set<string>();
  readonly #commands = new Map<string, CommandDeferred>();
  readonly #acknowledgements = new Map<string, Extract<V3CommandResult, { readonly outcome: "committed" | "satisfied" }>>();
  readonly #pendingRemovals = new Map<string, V3PendingTarget>();
  readonly #controlHeads = new Map<number, string>();
  readonly #controlEvents = new Map<number, string>();
  readonly #liveTargets = new Map<string, LiveDeferred>();
  readonly #requests = new Map<string, RequestDeferred>();
  readonly #commandRetryTimers = new Map<string, unknown>();
  readonly #liveRetryTimers = new Map<string, unknown>();
  readonly #pendingRemovalRetryTimers = new Map<string, unknown>();
  readonly #mediaEventEvidence = new Map<number, string>();
  readonly #presenceEventEvidence = new Map<number, string>();
  #phase: V3SessionSnapshot["connection"] = { phase: "idle" };
  #socket: V3Socket | null = null;
  #control: V3ControlState | null = null;
  #media: V3Projection<V3MediaPublication> | null = null;
  #presence: V3Projection<V3Presence> | null = null;
  #participantSessionId: string | null = null;
  #participantSessionGeneration: number | null = null;
  #recovery: Recovery | null = null;
  #started = false;
  #startupGeneration = 0;
  #reconnectTimer: unknown;
  #heartbeatTimer: unknown;
  #missedHeartbeats = 0;
  #unsubscribeLifecycle: (() => void) | undefined;
  #inbound = Promise.resolve();
  #transportAvailable = true;
  #online = true;
  #active = true;
  #unsubscribeLocalMedia: (() => void) | undefined;
  #unsubscribeRemoteMedia: (() => void) | undefined;
  #localPublications: readonly V3MediaPublication[] = [];
  #remotePublications: readonly V3MediaPublication[] = [];
  readonly #localMedia: Record<V3MediaSource, "unknown" | "requesting" | "enabled" | "disabled" | "failed"> = { microphone: "unknown", camera: "unknown", screen: "unknown" };

  constructor(options: V3SyncClientOptions) {
    assertV3Url(options.url);
    this.#options = options;
    this.#store = options.pendingStore ?? new InMemoryV3PendingTargetStore();
  }

  async start(): Promise<void> {
    if (this.#started) return;
    this.#started = true;
    const startupGeneration = ++this.#startupGeneration;
    let stored: readonly V3PendingTarget[];
    try {
      stored = await this.#store.load();
    } catch (error) {
      if (startupGeneration === this.#startupGeneration) {
        this.#started = false;
      }
      throw error;
    }
    if (!this.#started || startupGeneration !== this.#startupGeneration) return;
    const storedCommandIds = new Set(stored.map((pending) => pending.commandId));
    for (const commandId of this.#pendingTargets.keys()) {
      if (storedCommandIds.has(commandId) || this.#commands.has(commandId)) continue;
      this.#pendingTargets.delete(commandId);
    }
    for (const commandId of this.#pendingRemovals.keys()) {
      if (storedCommandIds.has(commandId)) continue;
      this.#pendingRemovals.delete(commandId);
      this.#clearPendingRemovalRetryTimer(commandId);
    }
    for (const pending of [...stored].sort(compareV3PendingTargets)) {
      if (this.#pendingRemovals.has(pending.commandId)) {
        void this.#removePersistedTarget(pending.commandId, pending);
      } else if (this.#commands.has(pending.commandId)) {
        this.#pendingTargets.set(pending.commandId, pending);
      } else {
        this.#pendingTargets.delete(pending.commandId);
        this.#restorePending(pending);
      }
    }
    this.#subscribeMediaPlane(this.#options.mediaPlane);
    this.#unsubscribeLifecycle = this.#options.lifecycle?.subscribe((event) => this.#handleLifecycle(event));
    this.#connect();
  }

  stop(): void {
    this.#started = false;
    this.#startupGeneration += 1;
    this.#unsubscribeLifecycle?.();
    this.#unsubscribeLifecycle = undefined;
    this.#clearReconnect();
    this.#clearHeartbeat();
    this.#clearRetryTimers();
    this.#clearPendingRemovalRetryTimers();
    this.#unsubscribeMediaPlane();
    this.#socket?.close(1000, "client stopped");
    this.#socket = null;
    this.#phase = { phase: "stopped" };
    this.#rejectEphemeral("client_stopped");
    this.#localPublications = [];
    this.#remotePublications = [];
    for (const source of ["microphone", "camera", "screen"] as const) this.#localMedia[source] = "unknown";
    for (const deferred of this.#commands.values()) rejectDeferred(deferred, new V3SyncError("client_stopped", "client_stopped"));
    this.#commands.clear();
    this.#acknowledgements.clear();
    this.#emit();
  }

  getSnapshot(): V3SessionSnapshot {
    const pendingCommands = [...this.#pendingTargets.values()].sort(compareV3PendingTargets).map((pending) => pending.command);
    const optimisticControl = this.#control && this.#participantSessionId ? optimisticV3Control(this.#control, this.#participantSessionId, pendingCommands) : this.#control;
    return {
      connection: { ...this.#phase },
      participantSessionId: this.#participantSessionId,
      participantSessionGeneration: this.#participantSessionGeneration,
      control: this.#control,
      optimisticControl,
      media: copyProjection(this.#media),
      presence: copyProjection(this.#presence),
      mediaPlane: { local: this.#localPublications.map(copyPublication), remote: this.#remotePublications.map(copyPublication) },
      localMedia: { ...this.#localMedia },
      pendingCommandCount: this.#pendingTargets.size,
    };
  }

  subscribe(listener: (snapshot: V3SessionSnapshot) => void): () => void {
    this.#listeners.add(listener);
    listener(this.getSnapshot());
    return () => this.#listeners.delete(listener);
  }

  onDirectedRequest(listener: (request: V3DirectedRequest) => void): () => void {
    this.#requestListeners.add(listener);
    return () => this.#requestListeners.delete(listener);
  }

  setHandRaised(raised: boolean, options?: CommandOptions): Promise<V3CommandResult> {
    return this.#sendTarget({ name: "set_hand_raised", payload: { raised } }, options);
  }

  setDisplayName(displayName: string, options?: CommandOptions): Promise<V3CommandResult> {
    return this.#sendTarget({ name: "set_display_name", payload: { display_name: displayName } }, options);
  }

  setAdmissionPolicy(policy: V3AdmissionPolicy, options?: CommandOptions): Promise<V3CommandResult> {
    return this.#sendTarget({ name: "set_admission_policy", payload: { policy } }, options);
  }

  setParticipantRole(participantSessionId: string, role: V3AssignableRole, options?: CommandOptions): Promise<V3CommandResult> {
    return this.#sendTarget({ name: "set_participant_role", payload: { participant_session_id: participantSessionId, role } }, options);
  }

  transferHost(participantSessionId: string, options?: CommandOptions): Promise<V3CommandResult> {
    return this.#sendTarget({ name: "transfer_host", payload: { participant_session_id: participantSessionId } }, options);
  }

  admit(admissionRequestId: string, options?: CommandOptions): Promise<V3CommandResult> {
    return this.#sendOperation("admit_participant", { admission_request_id: admissionRequestId }, options);
  }

  deny(admissionRequestId: string, options?: CommandOptions): Promise<V3CommandResult> {
    return this.#sendOperation("deny_admission", { admission_request_id: admissionRequestId }, options);
  }

  muteParticipant(participantSessionId: string, options?: CommandOptions): Promise<V3CommandResult> {
    return this.#sendOperation("mute_participant", { participant_session_id: participantSessionId }, options);
  }

  stopParticipantCamera(participantSessionId: string, options?: CommandOptions): Promise<V3CommandResult> {
    return this.#sendOperation("stop_participant_camera", { participant_session_id: participantSessionId }, options);
  }

  stopParticipantScreenShare(participantSessionId: string, options?: CommandOptions): Promise<V3CommandResult> {
    return this.#sendOperation("stop_participant_screen_share", { participant_session_id: participantSessionId }, options);
  }

  removeParticipant(participantSessionId: string, options?: CommandOptions): Promise<V3CommandResult> {
    return this.#sendOperation("remove_participant", { participant_session_id: participantSessionId }, options);
  }

  startRecording(options?: CommandOptions & { readonly recordingId?: string }): Promise<{ readonly recordingId: string; readonly result: V3CommandResult }> {
    const recordingId = options?.recordingId ?? this.#nextRequestId();
    return this.#sendOperation("start_recording", { recording_id: recordingId }, options).then((result) => ({ recordingId, result }));
  }

  stopRecording(recordingId: string, options?: CommandOptions): Promise<V3CommandResult> {
    return this.#sendOperation("stop_recording", { recording_id: recordingId }, options);
  }

  leave(options?: CommandOptions): Promise<V3CommandResult> {
    return this.#sendOperation("participant_leave", {}, options);
  }

  endSession(options?: CommandOptions): Promise<V3CommandResult> {
    return this.#sendOperation("end_session", {}, options);
  }

  setMicrophoneEnabled(enabled: boolean, options?: RequestOptions): Promise<V3SelfMediaTargetResult> {
    return this.#sendLiveTarget("set_microphone_enabled", "microphone", enabled, options);
  }

  setCameraEnabled(enabled: boolean, options?: RequestOptions): Promise<V3SelfMediaTargetResult> {
    return this.#sendLiveTarget("set_camera_enabled", "camera", enabled, options);
  }

  setScreenShareEnabled(enabled: boolean, options?: RequestOptions): Promise<V3SelfMediaTargetResult> {
    return this.#sendLiveTarget("set_screen_share_enabled", "screen", enabled, options);
  }

  requestUnmute(participantSessionId: string, options?: RequestOptions): Promise<V3DirectedRequestResult> {
    return this.#sendDirectedRequest("request_unmute", participantSessionId, options);
  }

  requestStartCamera(participantSessionId: string, options?: RequestOptions): Promise<V3DirectedRequestResult> {
    return this.#sendDirectedRequest("request_start_camera", participantSessionId, options);
  }

  async #sendTarget(command: V3TargetCommand, options?: CommandOptions): Promise<V3CommandResult> {
    this.#assertCapacity();
    const commandId = options?.commandId ?? this.#nextCommandId();
    if (this.#commands.has(commandId) || this.#pendingTargets.has(commandId) || this.#pendingRemovals.has(commandId) || this.#reservedCommandIds.has(commandId)) throw new V3SyncError("command ID is already pending", "command_id_conflict");
    const frame = { type: "command", command_id: commandId, name: command.name, payload: command.payload } as SyncV3ClientFrame;
    encodeV3ClientFrame(frame);
    const pending = { commandId, command, createdAt: this.#now(), bytes: encoder.encode(JSON.stringify(frame)).byteLength };
    if (this.#pendingBytes() + pending.bytes > (this.#options.maxPendingBytes ?? MAX_PENDING_BYTES)) throw new V3SyncError("pending target byte capacity exceeded", "capacity");
    this.#reservedCommandIds.add(commandId);
    try {
      await this.#store.put(pending);
      this.#pendingTargets.set(commandId, pending);
      const promise = this.#registerCommand(commandId, frame, true, pending.createdAt);
      this.#sendIfLive(frame);
      this.#emit();
      return promise;
    } finally {
      this.#reservedCommandIds.delete(commandId);
    }
  }

  #sendOperation(name: V3OperationName, payload: Record<string, string>, options?: CommandOptions): Promise<V3CommandResult> {
    this.#assertCapacity();
    const commandId = options?.commandId ?? this.#nextCommandId();
    if (this.#commands.has(commandId) || this.#pendingTargets.has(commandId) || this.#pendingRemovals.has(commandId) || this.#reservedCommandIds.has(commandId)) throw new V3SyncError("command ID is already pending", "command_id_conflict");
    const frame = { type: "operation", command_id: commandId, name, payload } as SyncV3ClientFrame;
    encodeV3ClientFrame(frame);
    const promise = this.#registerCommand(commandId, frame, false, this.#now());
    this.#sendIfLive(frame);
    return promise;
  }

  #sendLiveTarget(name: "set_microphone_enabled" | "set_camera_enabled" | "set_screen_share_enabled", source: V3MediaSource, enabled: boolean, options?: RequestOptions): Promise<V3SelfMediaTargetResult> {
    this.#assertCapacity();
    if (this.#phase.phase !== "live" || !this.#participantSessionId) return Promise.reject(new V3SyncError("self-media targets require a live participant", "not_live"));
    if (!this.#options.mediaPlane) return Promise.reject(new V3SyncError("a client MediaPlane adapter is required for self-media targets", "media_plane_unavailable"));
    const operationId = options?.requestId ?? this.#nextRequestId();
    if (this.#liveTargets.has(operationId) || this.#requests.has(operationId)) throw new V3SyncError("request ID is already pending", "request_id_conflict");
    const frame: LiveTargetClientFrame = { type: "live_target", operation_id: operationId, name, enabled };
    encodeV3ClientFrame(frame);
    const promise = new Promise<V3SelfMediaTargetResult>((resolve, reject) => this.#liveTargets.set(operationId, { resolve, reject, settled: false, frame, serverRetries: 0, localRetries: 0, localInFlight: false, source, enabled }));
    this.#localMedia[source] = "requesting";
    this.#sendIfLive(frame);
    this.#emit();
    return promise;
  }

  #sendDirectedRequest(name: "request_unmute" | "request_start_camera", participantSessionId: string, options?: RequestOptions): Promise<V3DirectedRequestResult> {
    this.#assertCapacity();
    if (this.#phase.phase !== "live") return Promise.reject(new V3SyncError("directed requests are live-only and are never queued for replay", "not_live"));
    const requestId = options?.requestId ?? this.#nextRequestId();
    if (this.#requests.has(requestId) || this.#liveTargets.has(requestId)) throw new V3SyncError("request ID is already pending", "request_id_conflict");
    const frame = { type: "directed_request", request_id: requestId, name, target_participant_session_id: participantSessionId } as const;
    encodeV3ClientFrame(frame);
    const promise = new Promise<V3DirectedRequestResult>((resolve, reject) => this.#requests.set(requestId, { resolve, reject, settled: false, frame }));
    this.#send(frame);
    return promise;
  }

  #registerCommand(commandId: string, frame: SyncV3ClientFrame, durableTarget: boolean, createdAt: number): Promise<V3CommandResult> {
    if (this.#commands.has(commandId)) throw new V3SyncError("command ID is already pending", "command_id_conflict");
    return new Promise((resolve, reject) => this.#commands.set(commandId, { resolve, reject, settled: false, frame, retries: 0, durableTarget, createdAt }));
  }

  #connect(): void {
    if (!this.#started || !this.#transportAvailable || this.#socket) return;
    this.#phase = { phase: "connecting" };
    this.#emit();
    const socket = this.#options.webSocket.connect(this.#options.url);
    this.#socket = socket;
    socket.onopen = () => void this.#authenticate(socket);
    socket.onmessage = (event) => {
      this.#inbound = this.#inbound.then(() => this.#receive(socket, event.data));
    };
    socket.onclose = () => this.#disconnected(socket);
    socket.onerror = () => socket.close(CLIENT_RESTART_CLOSE_CODE, "transport error");
  }

  async #authenticate(socket: V3Socket): Promise<void> {
    try {
      const token = await this.#options.token();
      if (socket !== this.#socket) return;
      this.#phase = { phase: "recovering" };
      this.#send({
        type: "hello",
        protocol: 3,
        token,
        streams: {
          control: { cursor: this.#control && { revision: this.#control.revision, state_schema_version: this.#control.stateSchemaVersion, state_digest: this.#control.stateDigest } },
          media: { cursor: null },
          presence: { cursor: null },
          requests: { cursor: null },
        },
      });
      this.#emit();
    } catch {
      socket.close(CLIENT_RESTART_CLOSE_CODE, "authentication failed");
    }
  }

  async #receive(socket: V3Socket, data: unknown): Promise<void> {
    if (socket !== this.#socket) return;
    try {
      if (typeof data !== "string" || encoder.encode(data).byteLength > SyncProtocolLimits.snapshotEncodedBytes) throw new V3ReplicaError("invalid inbound frame size");
      await this.#handleFrame(decodeV3ServerFrame(data));
    } catch {
      this.#recover("invalid_frame");
    }
  }

  async #handleFrame(frame: SyncV3ServerFrame): Promise<void> {
    switch (frame.type) {
      case "welcome":
        await this.#welcome(frame);
        return;
      case "replay_page":
        await this.#replay(frame);
        return;
      case "recovery_complete":
        this.#completeRecovery(frame);
        return;
      case "projection_snapshot":
        this.#replaceProjection(frame);
        return;
      case "projection_event":
        this.#applyProjection(frame);
        return;
      case "event":
        this.#requireLive();
        if (frame.revision <= this.#requireControl().revision) {
          if (this.#controlEvents.get(frame.revision) !== frameSignature(frame)) throw new V3ReplicaError("conflicting or unprovable duplicate control event");
        } else {
          this.#control = await applyV3Event(this.#requireControl(), frame);
          this.#rememberControlHead(this.#control.revision, this.#control.stateDigest);
          this.#rememberControlEvent(frame);
        }
        await this.#settleProvenCommands();
        {
          const control = this.#requireControl();
          this.#send({ type: "delivery_ack", stream: "control", revision: control.revision, state_digest: control.stateDigest });
        }
        this.#emit();
        return;
      case "ack":
        this.#requireLive();
        await this.#ack(frame);
        return;
      case "retryable_error":
        this.#requireLive();
        this.#retryCommand(frame.command_id, frame.code);
        return;
      case "live_target_result":
        this.#liveTargetResult(frame);
        return;
      case "directed_request_result":
        this.#requestResult(frame);
        return;
      case "directed_request":
        this.#directedRequest(frame);
        return;
      case "error":
        throw new V3ReplicaError(frame.code);
      case "pong":
        this.#requireLive();
        this.#missedHeartbeats = 0;
        return;
    }
  }

  async #welcome(frame: Extract<SyncV3ServerFrame, { readonly type: "welcome" }>): Promise<void> {
    if (this.#phase.phase !== "recovering" || this.#recovery) throw new V3ReplicaError("unexpected welcome");
    this.#participantSessionId = frame.participant_session_id;
    this.#participantSessionGeneration = frame.participant_session_generation;
    this.#updateLocalMediaStates();
    if (frame.mode === "terminal") {
      this.#phase = { phase: "terminal", terminalReason: frame.reason };
      this.#socket?.close(1000, "terminal recovery");
      this.#emit();
      return;
    }
    if (frame.mode === "snapshot") {
      this.#control = await restoreV3Snapshot(frame.snapshot);
      this.#controlHeads.clear();
      this.#controlEvents.clear();
      this.#rememberControlHead(this.#control.revision, this.#control.stateDigest);
    }
    if (frame.mode === "replay" && (!this.#control || this.#control.revision >= frame.head.revision)) throw new V3ReplicaError("invalid replay welcome");
    if (frame.mode === "up_to_date" && !sameHead(this.#control, frame.head)) throw new V3ReplicaError("up-to-date head mismatch");
    if (frame.mode === "snapshot" && !sameHead(this.#control, frame.head)) throw new V3ReplicaError("snapshot head mismatch");
    this.#recovery = { id: frame.recovery_id, head: frame.head, replayEvents: 0, replayBytes: 0, controlComplete: false };
    if (frame.mode !== "replay") this.#ackRecovery();
    this.#emit();
  }

  async #replay(frame: Extract<SyncV3ServerFrame, { readonly type: "replay_page" }>): Promise<void> {
    const recovery = this.#requireRecovery();
    if (frame.recovery_id !== recovery.id || frame.first_revision !== this.#requireControl().revision + 1) throw new V3ReplicaError("replay page is not exact-next");
    recovery.replayEvents += frame.events.length;
    recovery.replayBytes += encoder.encode(JSON.stringify(frame.events)).byteLength;
    if (recovery.replayEvents > MAX_REPLAY_EVENTS || recovery.replayBytes > MAX_REPLAY_BYTES) throw new V3ReplicaError("replay exceeds client bounds");
    for (const event of frame.events) {
      this.#control = await applyV3Event(this.#requireControl(), event);
      this.#rememberControlHead(this.#control.revision, this.#control.stateDigest);
      this.#rememberControlEvent(event);
    }
    this.#ackRecovery();
    this.#emit();
  }

  #completeRecovery(frame: Extract<SyncV3ServerFrame, { readonly type: "recovery_complete" }>): void {
    const recovery = this.#requireRecovery();
    if (frame.recovery_id !== recovery.id || !sameHead(this.#control, frame.head) || !sameRawHead(recovery.head, frame.head)) throw new V3ReplicaError("recovery completed at the wrong head");
    recovery.controlComplete = true;
    this.#enterLiveIfReady();
  }

  #replaceProjection(frame: Extract<SyncV3ServerFrame, { readonly type: "projection_snapshot" }>): void {
    if (this.#phase.phase !== "recovering" && this.#phase.phase !== "live") throw new V3ReplicaError("projection snapshot arrived in the wrong phase");
    if (frame.stream === "media") {
      this.#media = { projectionId: frame.projection_id, sequence: 0, items: frame.items.map(mediaItem) };
      this.#mediaEventEvidence.clear();
    } else {
      this.#presence = { projectionId: frame.projection_id, sequence: 0, items: frame.items.map(presenceItem) };
      this.#presenceEventEvidence.clear();
    }
    this.#enterLiveIfReady();
    this.#emit();
  }

  #applyProjection(frame: Extract<SyncV3ServerFrame, { readonly type: "projection_event" }>): void {
    this.#requireLive();
    if (frame.stream === "media") {
      if (this.#acceptProjectionDuplicate(this.#media, this.#mediaEventEvidence, frame)) return;
      this.#media = updateProjection(this.#media, frame.projection_id, frame.sequence, mediaItem(frame.item), mediaKey);
      rememberBoundedEvidence(this.#mediaEventEvidence, frame.sequence, frameSignature(frame), MAX_PROJECTION_EVENT_EVIDENCE);
    } else {
      if (this.#acceptProjectionDuplicate(this.#presence, this.#presenceEventEvidence, frame)) return;
      this.#presence = updateProjection(this.#presence, frame.projection_id, frame.sequence, presenceItem(frame.item), (item) => item.participantSessionId);
      rememberBoundedEvidence(this.#presenceEventEvidence, frame.sequence, frameSignature(frame), MAX_PROJECTION_EVENT_EVIDENCE);
    }
    this.#emit();
  }

  async #ack(frame: V3CommandResult): Promise<void> {
    const deferred = this.#commands.get(frame.command_id);
    if (!deferred) return;
    if (frame.outcome === "rejected" || frame.outcome === "command_id_conflict") {
      await this.#finishCommand(frame.command_id, frame);
      return;
    }
    if (!this.#ackHeadIsProven(frame)) {
      const previous = this.#acknowledgements.get(frame.command_id);
      if (previous && JSON.stringify(previous) !== JSON.stringify(frame)) throw new V3ReplicaError("conflicting duplicate command ACK");
      this.#acknowledgements.set(frame.command_id, frame);
      return;
    }
    await this.#finishCommand(frame.command_id, frame);
  }

  async #settleProvenCommands(): Promise<void> {
    for (const commandId of this.#commands.keys()) {
      const ack = this.#acknowledgements.get(commandId);
      if (ack && this.#ackHeadIsProven(ack)) await this.#finishCommand(commandId, ack);
    }
  }

  #retryCommand(commandId: string, code: Extract<SyncV3ServerFrame, { readonly type: "retryable_error" }>["code"]): void {
    const deferred = this.#commands.get(commandId);
    if (!deferred || this.#commandRetryTimers.has(commandId)) return;
    if (code === "external_operation_pending") {
      this.#pollPendingOperation(commandId, deferred);
      return;
    }
    if (deferred.retries >= MAX_RETRIES) {
      rejectDeferred(deferred, new V3SyncError(code, "retry_exhausted"));
      if (!deferred.durableTarget) this.#commands.delete(commandId);
      return;
    }
    deferred.retries += 1;
    const timer = this.#clock().setTimeout(() => {
      this.#commandRetryTimers.delete(commandId);
      if (this.#commands.get(commandId) === deferred) this.#sendIfLive(deferred.frame);
    }, this.#options.retryDelayMs ?? 100);
    this.#commandRetryTimers.set(commandId, timer);
  }

  #pollPendingOperation(commandId: string, deferred: CommandDeferred): void {
    const remainingAge = (this.#options.maxOperationPendingAgeMs ?? MAX_PENDING_AGE_MS) - (this.#now() - deferred.createdAt);
    if (remainingAge <= 0) {
      this.#expirePendingOperation(commandId, deferred);
      return;
    }
    const timer = this.#clock().setTimeout(
      () => {
        this.#commandRetryTimers.delete(commandId);
        if (this.#commands.get(commandId) !== deferred) return;
        if (this.#now() - deferred.createdAt >= (this.#options.maxOperationPendingAgeMs ?? MAX_PENDING_AGE_MS)) {
          this.#expirePendingOperation(commandId, deferred);
          return;
        }
        this.#sendIfLive(deferred.frame);
      },
      Math.min(OPERATION_PENDING_POLL_INTERVAL_MS, remainingAge),
    );
    this.#commandRetryTimers.set(commandId, timer);
  }

  #expirePendingOperation(commandId: string, deferred: CommandDeferred): void {
    if (this.#commands.get(commandId) !== deferred) return;
    this.#commands.delete(commandId);
    this.#acknowledgements.delete(commandId);
    this.#clearCommandRetryTimer(commandId);
    let pending: V3PendingTarget | undefined;
    if (deferred.durableTarget) {
      pending = this.#pendingTargets.get(commandId);
      this.#pendingTargets.delete(commandId);
      if (pending) this.#pendingRemovals.set(commandId, pending);
    }
    rejectDeferred(deferred, new V3SyncError("external operation remained pending beyond its maximum age", "operation_pending_timeout"));
    this.#emit();
    if (pending) void this.#removePersistedTarget(commandId, pending);
  }

  #liveTargetResult(frame: V3LiveTargetResult): void {
    this.#requireLive();
    const deferred = this.#liveTargets.get(frame.operation_id);
    if (!deferred || deferred.frame.name !== frame.name) return;
    if (deferred.serverResultSignature) {
      if (deferred.serverResultSignature !== frameSignature(frame)) throw new V3ReplicaError("conflicting duplicate live-target result");
      return;
    }
    if (frame.outcome === "retryable_failure") {
      this.#retryLiveServer(frame.operation_id, deferred, frame.error_code ?? frame.outcome);
      return;
    }
    if (frame.outcome !== "confirmed" && frame.outcome !== "satisfied") {
      this.#failLiveTarget(frame.operation_id, deferred, new V3SyncError(frame.error_code ?? frame.outcome, frame.outcome));
      return;
    }
    deferred.serverResult = { ...frame, outcome: frame.outcome } as SuccessfulLiveTargetResult;
    deferred.serverResultSignature = frameSignature(frame);
    this.#executeLocalMediaTarget(frame.operation_id, deferred);
  }

  #retryLiveServer(operationId: string, deferred: LiveDeferred, errorCode: string): void {
    if (this.#liveRetryTimers.has(operationId)) return;
    if (deferred.serverRetries >= MAX_RETRIES) {
      this.#failLiveTarget(operationId, deferred, new V3SyncError(errorCode, "retry_exhausted"));
      return;
    }
    deferred.serverRetries += 1;
    this.#scheduleLiveRetry(operationId, () => this.#sendIfLive(deferred.frame));
  }

  #executeLocalMediaTarget(operationId: string, deferred: LiveDeferred): void {
    const mediaPlane = this.#options.mediaPlane;
    const participantSessionId = this.#participantSessionId;
    if (!mediaPlane || !participantSessionId || deferred.localInFlight || this.#liveTargets.get(operationId) !== deferred) return;
    deferred.localInFlight = true;
    let result: Promise<V3MediaPlaneResult>;
    try {
      result = mediaPlane.setLocalPublicationTarget({ operationId, participantSessionId, source: deferred.source, enabled: deferred.enabled });
    } catch {
      this.#localMediaResult(operationId, deferred, { outcome: "ambiguous", errorCode: "media_plane_exception" });
      return;
    }
    void result
      .then((outcome) => this.#localMediaResult(operationId, deferred, validMediaPlaneResult(outcome) ? outcome : { outcome: "ambiguous", errorCode: "invalid_media_plane_result" }))
      .catch(() => this.#localMediaResult(operationId, deferred, { outcome: "ambiguous", errorCode: "media_plane_exception" }));
  }

  #localMediaResult(operationId: string, deferred: LiveDeferred, result: V3MediaPlaneResult): void {
    if (this.#liveTargets.get(operationId) !== deferred) return;
    deferred.localInFlight = false;
    if (result.outcome === "retryable_failure") {
      if (deferred.localRetries >= MAX_RETRIES) {
        this.#failLiveTarget(operationId, deferred, new V3SyncError(result.errorCode ?? result.outcome, "retry_exhausted"));
        return;
      }
      deferred.localRetries += 1;
      this.#scheduleLiveRetry(operationId, () => this.#executeLocalMediaTarget(operationId, deferred));
      return;
    }
    if (result.outcome !== "confirmed" && result.outcome !== "satisfied") {
      this.#failLiveTarget(operationId, deferred, new V3SyncError(result.errorCode ?? result.outcome, result.outcome));
      return;
    }
    const serverResult = deferred.serverResult;
    if (!serverResult) throw new V3ReplicaError("local MediaPlane completed before server authorization");
    this.#liveTargets.delete(operationId);
    this.#clearLiveRetryTimer(operationId);
    this.#localMedia[deferred.source] = deferred.enabled ? "enabled" : "disabled";
    resolveDeferred(deferred, { operationId, name: deferred.frame.name, serverOutcome: serverResult.outcome, mediaPlaneOutcome: result.outcome });
    this.#emit();
  }

  #scheduleLiveRetry(operationId: string, retry: () => void): void {
    const timer = this.#clock().setTimeout(() => {
      this.#liveRetryTimers.delete(operationId);
      retry();
    }, this.#options.retryDelayMs ?? 100);
    this.#liveRetryTimers.set(operationId, timer);
  }

  #failLiveTarget(operationId: string, deferred: LiveDeferred, error: V3SyncError): void {
    this.#liveTargets.delete(operationId);
    this.#clearLiveRetryTimer(operationId);
    this.#localMedia[deferred.source] = "failed";
    rejectDeferred(deferred, error);
    this.#emit();
  }

  #requestResult(frame: V3DirectedRequestResult): void {
    this.#requireLive();
    const deferred = this.#requests.get(frame.request_id);
    if (!deferred) return;
    this.#requests.delete(frame.request_id);
    resolveDeferred(deferred, frame);
  }

  #directedRequest(frame: V3DirectedRequest): void {
    this.#requireLive();
    if (frame.expires_at_ms <= this.#now()) return;
    this.#send({ type: "request_ack", request_id: frame.request_id });
    for (const listener of this.#requestListeners) listener(frame);
  }

  async #finishCommand(commandId: string, result: V3CommandResult): Promise<void> {
    const deferred = this.#commands.get(commandId);
    if (!deferred) return;
    this.#commands.delete(commandId);
    this.#clearCommandRetryTimer(commandId);
    this.#acknowledgements.delete(commandId);
    let pending: V3PendingTarget | undefined;
    if (deferred.durableTarget) {
      pending = this.#pendingTargets.get(commandId);
      this.#pendingTargets.delete(commandId);
      if (pending) this.#pendingRemovals.set(commandId, pending);
    }
    if (result.outcome === "rejected" || result.outcome === "command_id_conflict") rejectDeferred(deferred, new V3SyncError(result.reason, result.outcome));
    else resolveDeferred(deferred, result);
    this.#emit();
    if (pending) void this.#removePersistedTarget(commandId, pending);
  }

  #enterLiveIfReady(): void {
    if (!this.#recovery?.controlComplete || !this.#media || !this.#presence) return;
    this.#recovery = null;
    this.#phase = { phase: "live" };
    this.#missedHeartbeats = 0;
    for (const pending of this.#commands.values()) {
      pending.retries = 0;
      this.#send(pending.frame);
    }
    for (const pending of this.#liveTargets.values()) {
      pending.serverRetries = 0;
      if (pending.serverResult) this.#executeLocalMediaTarget(pending.frame.operation_id, pending);
      else this.#send(pending.frame);
    }
    this.#startHeartbeat();
    this.#emit();
  }

  #ackRecovery(): void {
    const recovery = this.#requireRecovery();
    const control = this.#requireControl();
    this.#send({ type: "recovery_ack", recovery_id: recovery.id, revision: control.revision, state_digest: control.stateDigest });
  }

  #restorePending(pending: V3PendingTarget): void {
    if (this.#pendingTargets.size + this.#pendingRemovals.size >= this.#maxPending() || this.#now() - pending.createdAt > (this.#options.maxPendingAgeMs ?? MAX_PENDING_AGE_MS) || this.#pendingBytes() + pending.bytes > (this.#options.maxPendingBytes ?? MAX_PENDING_BYTES)) {
      void this.#removePersistedTarget(pending.commandId, pending);
      return;
    }
    const frame = { type: "command", command_id: pending.commandId, name: pending.command.name, payload: pending.command.payload } as SyncV3ClientFrame;
    encodeV3ClientFrame(frame);
    this.#pendingTargets.set(pending.commandId, pending);
    this.#commands.set(pending.commandId, { resolve: () => undefined, reject: () => undefined, settled: true, frame, retries: 0, durableTarget: true, createdAt: pending.createdAt });
  }

  async #removePersistedTarget(commandId: string, pending: V3PendingTarget): Promise<void> {
    this.#pendingRemovals.set(commandId, pending);
    try {
      await this.#store.remove(commandId);
      if (this.#pendingRemovals.get(commandId) !== pending) return;
      this.#pendingRemovals.delete(commandId);
      this.#clearPendingRemovalRetryTimer(commandId);
    } catch {
      if (this.#pendingRemovals.get(commandId) !== pending) return;
      this.#schedulePendingRemovalRetry(commandId, pending);
    }
  }

  #schedulePendingRemovalRetry(commandId: string, pending: V3PendingTarget): void {
    if (!this.#started || this.#pendingRemovalRetryTimers.has(commandId)) return;
    const timer = this.#clock().setTimeout(() => {
      this.#pendingRemovalRetryTimers.delete(commandId);
      void this.#removePersistedTarget(commandId, pending);
    }, this.#options.retryDelayMs ?? 100);
    this.#pendingRemovalRetryTimers.set(commandId, timer);
  }

  #ackHeadIsProven(ack: Extract<V3CommandResult, { readonly outcome: "committed" | "satisfied" }>): boolean {
    return this.#controlHeads.get(ack.revision) === ack.state_digest;
  }

  #rememberControlHead(revision: number, digest: string): void {
    this.#controlHeads.set(revision, digest);
    if (this.#controlHeads.size <= MAX_REPLAY_EVENTS) return;
    const oldest = this.#controlHeads.keys().next().value;
    if (oldest !== undefined) this.#controlHeads.delete(oldest);
  }

  #rememberControlEvent(event: Extract<SyncV3ServerFrame, { readonly type: "event" }>): void {
    rememberBoundedEvidence(this.#controlEvents, event.revision, frameSignature(event), MAX_REPLAY_EVENTS);
  }

  #acceptProjectionDuplicate<T>(projection: V3Projection<T> | null, evidence: ReadonlyMap<number, string>, frame: Extract<SyncV3ServerFrame, { readonly type: "projection_event" }>): boolean {
    if (!projection || frame.projection_id !== projection.projectionId || frame.sequence > projection.sequence) return false;
    if (evidence.get(frame.sequence) !== frameSignature(frame)) throw new V3ReplicaError("conflicting or unprovable duplicate projection event");
    return true;
  }

  #disconnected(socket: V3Socket): void {
    if (socket !== this.#socket) return;
    this.#socket = null;
    this.#recovery = null;
    this.#clearHeartbeat();
    this.#clearRetryTimers();
    this.#media = null;
    this.#presence = null;
    this.#rejectRequests("disconnected_before_delivery");
    if (!this.#started || !this.#transportAvailable || this.#phase.phase === "terminal") return;
    this.#phase = { phase: "connecting" };
    this.#emit();
    this.#clearReconnect();
    this.#reconnectTimer = this.#clock().setTimeout(() => {
      this.#reconnectTimer = undefined;
      this.#connect();
    }, this.#options.reconnectDelayMs ?? 250);
  }

  #recover(reason: string): void {
    const socket = this.#socket;
    if (!socket) return;
    socket.close(CLIENT_RESTART_CLOSE_CODE, reason);
    this.#disconnected(socket);
  }

  #handleLifecycle(event: "online" | "offline" | "active" | "inactive"): void {
    if (event === "online" || event === "offline") this.#online = event === "online";
    else this.#active = event === "active";
    this.#transportAvailable = this.#online && this.#active;
    if (!this.#transportAvailable) this.#socket?.close(CLIENT_RESTART_CLOSE_CODE, "lifecycle unavailable");
    else this.#connect();
  }

  #rejectEphemeral(code: string): void {
    this.#rejectRequests(code);
    for (const deferred of this.#liveTargets.values()) rejectDeferred(deferred, new V3SyncError(code, code));
    this.#liveTargets.clear();
  }

  #rejectRequests(code: string): void {
    for (const deferred of this.#requests.values()) rejectDeferred(deferred, new V3SyncError(code, code));
    this.#requests.clear();
  }

  #sendIfLive(frame: SyncV3ClientFrame): void {
    if (this.#phase.phase === "live") this.#send(frame);
  }

  #send(frame: SyncV3ClientFrame): void {
    this.#socket?.send(encodeV3ClientFrame(frame));
  }

  #requireLive(): void {
    if (this.#phase.phase !== "live") throw new V3ReplicaError("live frame arrived before four-stream recovery completed");
  }

  #requireControl(): V3ControlState {
    if (!this.#control) throw new V3ReplicaError("control replica is unavailable");
    return this.#control;
  }

  #requireRecovery(): Recovery {
    if (!this.#recovery || this.#phase.phase !== "recovering") throw new V3ReplicaError("recovery frame arrived outside recovery");
    return this.#recovery;
  }

  #assertCapacity(): void {
    if (this.#commands.size + this.#pendingRemovals.size + this.#reservedCommandIds.size + this.#liveTargets.size + this.#requests.size >= this.#maxPending()) throw new V3SyncError("in-flight request capacity exceeded", "capacity");
  }

  #maxPending(): number {
    return Math.min(this.#options.maxPendingCommands ?? MAX_IN_FLIGHT, MAX_IN_FLIGHT);
  }

  #pendingBytes(): number {
    return [...this.#pendingTargets.values(), ...this.#pendingRemovals.values()].reduce((total, pending) => total + pending.bytes, 0);
  }

  #nextCommandId(): string {
    return this.#options.ids?.next() ?? crypto.randomUUID();
  }

  #nextRequestId(): string {
    return this.#options.requestIds?.next() ?? crypto.randomUUID();
  }

  #clock(): NonNullable<V3SyncClientOptions["clock"]> {
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

  #clearReconnect(): void {
    if (this.#reconnectTimer === undefined) return;
    this.#clock().clearTimeout(this.#reconnectTimer);
    this.#reconnectTimer = undefined;
  }

  #subscribeMediaPlane(mediaPlane: V3ClientMediaPlane | undefined): void {
    if (!mediaPlane) return;
    try {
      this.#unsubscribeLocalMedia = mediaPlane.observeLocalPublications((publications) => this.#replaceMediaPlanePublications("local", publications));
      this.#unsubscribeRemoteMedia = mediaPlane.observeRemotePublications((publications) => this.#replaceMediaPlanePublications("remote", publications));
    } catch {
      this.#unsubscribeMediaPlane();
      this.#started = false;
      throw new V3SyncError("unable to observe the client MediaPlane", "media_plane_unavailable");
    }
  }

  #unsubscribeMediaPlane(): void {
    this.#unsubscribeLocalMedia?.();
    this.#unsubscribeRemoteMedia?.();
    this.#unsubscribeLocalMedia = undefined;
    this.#unsubscribeRemoteMedia = undefined;
  }

  #replaceMediaPlanePublications(kind: "local" | "remote", publications: readonly V3MediaPublication[]): void {
    if (publications.length > SyncProtocolLimits.projectionMaxItems || !publications.every(validMediaPublication)) return;
    const copy = publications.map(copyPublication);
    if (kind === "local") {
      this.#localPublications = copy;
      this.#updateLocalMediaStates();
    } else {
      this.#remotePublications = copy;
    }
    this.#emit();
  }

  #updateLocalMediaStates(): void {
    if (!this.#participantSessionId) return;
    for (const source of ["microphone", "camera", "screen"] as const) {
      const publication = this.#localPublications.find((candidate) => candidate.source === source && candidate.participantSessionId === this.#participantSessionId);
      this.#localMedia[source] = publication?.enabled ? "enabled" : "disabled";
    }
  }

  #clearRetryTimers(): void {
    for (const timer of this.#commandRetryTimers.values()) this.#clock().clearTimeout(timer);
    for (const timer of this.#liveRetryTimers.values()) this.#clock().clearTimeout(timer);
    this.#commandRetryTimers.clear();
    this.#liveRetryTimers.clear();
  }

  #clearPendingRemovalRetryTimers(): void {
    for (const timer of this.#pendingRemovalRetryTimers.values()) this.#clock().clearTimeout(timer);
    this.#pendingRemovalRetryTimers.clear();
  }

  #clearPendingRemovalRetryTimer(commandId: string): void {
    const timer = this.#pendingRemovalRetryTimers.get(commandId);
    if (timer === undefined) return;
    this.#clock().clearTimeout(timer);
    this.#pendingRemovalRetryTimers.delete(commandId);
  }

  #clearLiveRetryTimer(operationId: string): void {
    const timer = this.#liveRetryTimers.get(operationId);
    if (timer === undefined) return;
    this.#clock().clearTimeout(timer);
    this.#liveRetryTimers.delete(operationId);
  }

  #clearCommandRetryTimer(commandId: string): void {
    const timer = this.#commandRetryTimers.get(commandId);
    if (timer === undefined) return;
    this.#clock().clearTimeout(timer);
    this.#commandRetryTimers.delete(commandId);
  }

  #startHeartbeat(): void {
    this.#clearHeartbeat();
    this.#heartbeatTimer = this.#clock().setTimeout(() => {
      this.#heartbeatTimer = undefined;
      if (this.#phase.phase !== "live") return;
      this.#missedHeartbeats += 1;
      if (this.#missedHeartbeats > 2) {
        this.#socket?.close(CLIENT_RESTART_CLOSE_CODE, "heartbeat timeout");
        return;
      }
      this.#send({ type: "ping" });
      this.#startHeartbeat();
    }, 20_000);
  }

  #clearHeartbeat(): void {
    if (this.#heartbeatTimer === undefined) return;
    this.#clock().clearTimeout(this.#heartbeatTimer);
    this.#heartbeatTimer = undefined;
  }

  #emit(): void {
    const snapshot = this.getSnapshot();
    for (const listener of this.#listeners) listener(snapshot);
  }
}

function updateProjection<T>(projection: V3Projection<T> | null, projectionId: string, sequence: number, item: T, key: (item: T) => string): V3Projection<T> {
  if (!projection || projection.projectionId !== projectionId) throw new V3ReplicaError("projection event has no matching replace snapshot");
  if (sequence !== projection.sequence + 1) throw new V3ReplicaError("projection event is not exact-next");
  const itemKey = key(item);
  return { projectionId, sequence, items: [...projection.items.filter((candidate) => key(candidate) !== itemKey), item] };
}

function mediaItem(item: { readonly participant_session_id: string; readonly source: V3MediaSource; readonly enabled: boolean; readonly publication_id: string | null }): V3MediaPublication {
  return { participantSessionId: item.participant_session_id, source: item.source, enabled: item.enabled, publicationId: item.publication_id };
}

function presenceItem(item: { readonly participant_session_id: string; readonly state: "connected" | "disconnected"; readonly speaking: boolean; readonly active_speaker: boolean }): V3Presence {
  return { participantSessionId: item.participant_session_id, state: item.state, speaking: item.speaking, activeSpeaker: item.active_speaker };
}

function mediaKey(item: V3MediaPublication): string {
  return `${item.participantSessionId}:${item.source}`;
}

function sameHead(control: V3ControlState | null, head: { readonly revision: number; readonly state_schema_version: number; readonly state_digest: string }): boolean {
  return control !== null && control.revision === head.revision && control.stateSchemaVersion === head.state_schema_version && control.stateDigest === head.state_digest;
}

function sameRawHead(left: Recovery["head"], right: Recovery["head"]): boolean {
  return left.revision === right.revision && left.state_schema_version === right.state_schema_version && left.state_digest === right.state_digest;
}

function copyProjection<T>(projection: V3Projection<T> | null): V3Projection<T> | null {
  return projection && { ...projection, items: projection.items.map((item) => ({ ...item })) };
}

function frameSignature(frame: unknown): string {
  return new TextDecoder().decode(canonicalJsonBytesFromUnknown(frame));
}

function rememberBoundedEvidence(evidence: Map<number, string>, sequence: number, signature: string, capacity: number): void {
  evidence.set(sequence, signature);
  if (evidence.size <= capacity) return;
  const oldest = evidence.keys().next().value;
  if (oldest !== undefined) evidence.delete(oldest);
}

function resolveDeferred<T>(deferred: Deferred<T>, value: T): void {
  if (deferred.settled) return;
  deferred.settled = true;
  deferred.resolve(value);
}

function rejectDeferred<T>(deferred: Deferred<T>, error: Error): void {
  if (deferred.settled) return;
  deferred.settled = true;
  deferred.reject(error);
}

function copyPublication(publication: V3MediaPublication): V3MediaPublication {
  return { ...publication };
}

function validMediaPublication(publication: V3MediaPublication): boolean {
  return (
    typeof publication.participantSessionId === "string" &&
    publication.participantSessionId.length > 0 &&
    (publication.source === "microphone" || publication.source === "camera" || publication.source === "screen") &&
    typeof publication.enabled === "boolean" &&
    (publication.publicationId === null || typeof publication.publicationId === "string") &&
    publication.enabled === (publication.publicationId !== null)
  );
}

function validMediaPlaneResult(result: V3MediaPlaneResult): boolean {
  return (result.outcome === "confirmed" || result.outcome === "satisfied" || result.outcome === "retryable_failure" || result.outcome === "terminal_failure" || result.outcome === "ambiguous") && (result.errorCode === null || typeof result.errorCode === "string");
}

function assertV3Url(value: string): void {
  const url = new URL(value);
  if (url.pathname !== "/v3/sync") throw new V3SyncError("SyncEngine v3 websocket URL must use /v3/sync", "invalid_url");
}
