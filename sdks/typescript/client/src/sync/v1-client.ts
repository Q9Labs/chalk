import { SyncProtocolLimits, type SyncV1ClientFrame, type SyncV1ServerFrame } from "../generated/sync";
import type { ClientMediaPlane } from "../media/plane";
import type { ChalkChatMessage, ChalkChatPageResult, ChalkChatReadReceipt, ChalkReaction, ChalkReactionEvent, ChalkSendChatMessageInput, ChalkSyncV1CollaborationCapability } from "../collaboration/types";
import { syncTelemetryCorrelation } from "../telemetry/sync";
import { encodeV1ClientFrame, decodeV1ServerFrame } from "./v1-codec";
import { V1CollaborationState } from "./v1-collaboration-state";
import { V1CommandScheduler, type V1OperationFrameFactory } from "./v1-command-scheduler";
import { rejectV1Deferred as rejectDeferred, resolveV1Deferred as resolveDeferred, type V1Deferred as Deferred } from "./v1-deferred";
import { V1SyncError } from "./v1-error";
import { frameSignature } from "./v1-frame-signature";
import { V1LiveTargetCoordinator } from "./v1-live-target-coordinator";
import { InMemoryV1PendingTargetStore } from "./v1-persistence";
import { applyV1Event, optimisticV1Control, restoreV1Snapshot, V1ReplicaError } from "./v1-reducer";
import type {
  V1AdmissionPolicy,
  V1AssignableRole,
  V1CommandResult,
  V1ControlState,
  V1DirectedRequest,
  V1DirectedRequestResult,
  V1MediaPublication,
  V1MediaSource,
  V1PendingTarget,
  V1Presence,
  V1Projection,
  V1CollaborationEvent,
  V1CollaborationClient,
  V1CollaborationExtensionState,
  V1EpisodeSnapshot,
  V1SelfMediaTargetResult,
  V1Socket,
  V1SyncClientOptions,
  V1TargetCommand,
} from "./v1-types";

const encoder = new TextEncoder();
const MAX_REPLAY_EVENTS = SyncProtocolLimits.completeReplayMaxEvents;
const MAX_REPLAY_BYTES = SyncProtocolLimits.completeReplayEncodedBytes;
const MAX_PROJECTION_EVENT_EVIDENCE = 256;
const CLIENT_RESTART_CLOSE_CODE = 4000;
const DEFAULT_RECONNECT_DELAY_MS = 250;
const MAX_RECONNECT_DELAY_MS = 5_000;

type RequestDeferred = Deferred<V1DirectedRequestResult> & { readonly frame: SyncV1ClientFrame };
type Recovery = { readonly id: string; readonly head: { readonly revision: number; readonly state_schema_version: number; readonly state_digest: string }; replayEvents: number; replayBytes: number; controlComplete: boolean };
type CommandOptions = { readonly commandId?: string };
type RequestOptions = { readonly requestId?: string };

export { V1SyncError } from "./v1-error";

export class V1SyncClient implements V1CollaborationClient {
  readonly #options: V1SyncClientOptions;
  readonly #commandScheduler: V1CommandScheduler;
  readonly #listeners = new Set<(snapshot: V1EpisodeSnapshot) => void>();
  readonly #requestListeners = new Set<(request: V1DirectedRequest) => void>();
  readonly #collaborationState: V1CollaborationState;
  readonly #controlHeads = new Map<number, string>();
  readonly #controlEvents = new Map<number, string>();
  readonly #liveTargets: V1LiveTargetCoordinator;
  readonly #requests = new Map<string, RequestDeferred>();
  readonly #mediaEventEvidence = new Map<number, string>();
  readonly #presenceEventEvidence = new Map<number, string>();
  #phase: V1EpisodeSnapshot["connection"] = { phase: "idle" };
  #socket: V1Socket | null = null;
  #control: V1ControlState | null = null;
  #media: V1Projection<V1MediaPublication> | null = null;
  #presence: V1Projection<V1Presence> | null = null;
  #participantId: string | null = null;
  #participantGeneration: number | null = null;
  #recovery: Recovery | null = null;
  #started = false;
  #startupGeneration = 0;
  #connectionGeneration = 0;
  #reconnectTimer: unknown;
  #reconnectAttempt = 0;
  #heartbeatTimer: unknown;
  #missedHeartbeats = 0;
  #unsubscribeLifecycle: (() => void) | undefined;
  #inbound = Promise.resolve();
  #transportAvailable = true;
  #online = true;
  #active = true;
  #unsubscribeLocalMedia: (() => void) | undefined;
  #unsubscribeRemoteMedia: (() => void) | undefined;
  #localPublications: readonly V1MediaPublication[] = [];
  #remotePublications: readonly V1MediaPublication[] = [];

  constructor(options: V1SyncClientOptions) {
    assertV1Url(options.url);
    this.#options = options;
    this.#commandScheduler = new V1CommandScheduler({
      store: options.pendingStore ?? new InMemoryV1PendingTargetStore(),
      ids: options.ids,
      maxPendingCommands: options.maxPendingCommands,
      maxPendingBytes: options.maxPendingBytes,
      maxPendingAgeMs: options.maxPendingAgeMs,
      maxOperationPendingAgeMs: options.maxOperationPendingAgeMs,
      retryDelayMs: options.retryDelayMs,
      clock: () => this.#clock(),
      isStarted: () => this.#started,
      sendIfLive: (frame) => this.#sendIfLive(frame),
      stateChanged: () => this.#emit(),
      ackHeadIsProven: (ack) => this.#ackHeadIsProven(ack),
    });
    this.#liveTargets = new V1LiveTargetCoordinator({
      mediaPlane: options.mediaPlane,
      requestIds: options.requestIds,
      retryDelayMs: options.retryDelayMs,
      clock: () => this.#clock(),
      participantId: () => this.#participantId,
      isLive: () => this.#phase.phase === "live",
      requestIdInUse: (requestId) => this.#requests.has(requestId),
      assertCapacity: () => this.#assertCapacity(),
      sendIfLive: (frame) => this.#sendIfLive(frame),
      stateChanged: () => this.#emit(),
    });
    this.#collaborationState = new V1CollaborationState({
      request: options.collaboration,
      requestIds: options.requestIds,
      maxPendingRequests: options.maxPendingCollaborationRequests,
      isLive: () => this.#phase.phase === "live",
      send: (frame) => this.#send(frame),
      stateChanged: () => this.#emit(),
    });
  }

  async start(): Promise<void> {
    if (this.#started) return;
    this.#started = true;
    const startupGeneration = ++this.#startupGeneration;
    let stored: readonly V1PendingTarget[];
    try {
      stored = await this.#commandScheduler.load();
    } catch (error) {
      if (startupGeneration === this.#startupGeneration) {
        this.#started = false;
      }
      throw error;
    }
    if (!this.#started || startupGeneration !== this.#startupGeneration) return;
    this.#commandScheduler.reconcileStored(stored);
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
    this.#commandScheduler.stop("client_stopped");
    this.#unsubscribeMediaPlane();
    this.#socket?.close(1000, "client stopped");
    this.#socket = null;
    this.#phase = { phase: "stopped" };
    this.#rejectEphemeral("client_stopped");
    this.#collaborationState.disconnect("client_stopped");
    this.#localPublications = [];
    this.#remotePublications = [];
    this.#liveTargets.resetLocalMedia();
    this.#emit();
  }

  getSnapshot(): V1EpisodeSnapshot {
    const pendingCommands = this.#commandScheduler.pendingCommands;
    const optimisticControl = this.#control && this.#participantId ? optimisticV1Control(this.#control, this.#participantId, pendingCommands) : this.#control;
    return {
      connection: { ...this.#phase },
      participantId: this.#participantId,
      participantGeneration: this.#participantGeneration,
      control: this.#control,
      optimisticControl,
      media: copyProjection(this.#media),
      presence: copyProjection(this.#presence),
      mediaPlane: { local: this.#localPublications.map(copyPublication), remote: this.#remotePublications.map(copyPublication) },
      localMedia: this.#liveTargets.getLocalMedia(),
      pendingCommandCount: this.#commandScheduler.pendingCount,
    };
  }

  subscribe(listener: (snapshot: V1EpisodeSnapshot) => void): () => void {
    this.#listeners.add(listener);
    listener(this.getSnapshot());
    return () => this.#listeners.delete(listener);
  }

  onDirectedRequest(listener: (request: V1DirectedRequest) => void): () => void {
    this.#requestListeners.add(listener);
    return () => this.#requestListeners.delete(listener);
  }

  getCollaborationExtensionState(): V1CollaborationExtensionState {
    return this.#collaborationState.getState();
  }

  getParticipantCollaborationCapabilities(): Readonly<Record<string, readonly ChalkSyncV1CollaborationCapability[]>> {
    return this.#collaborationState.getParticipantCapabilities();
  }

  subscribeCollaboration(listener: (event: V1CollaborationEvent) => void): () => void {
    return this.#collaborationState.subscribe(listener);
  }

  sendReaction(reaction: ChalkReaction): Promise<ChalkReactionEvent> {
    return this.#collaborationState.sendReaction(reaction);
  }

  sendChatMessage(input: ChalkSendChatMessageInput): Promise<ChalkChatMessage> {
    return this.#collaborationState.sendChatMessage(input);
  }

  markChatRead(sequence: string): Promise<ChalkChatReadReceipt> {
    return this.#collaborationState.markChatRead(sequence);
  }

  readChatPage(input: { readonly beforeSequence?: string; readonly afterSequence?: string; readonly limit: number }): Promise<ChalkChatPageResult> {
    return this.#collaborationState.readChatPage(input);
  }

  setHandRaised(raised: boolean, options?: CommandOptions): Promise<V1CommandResult> {
    return this.#sendTarget({ name: "set_hand_raised", payload: { raised } }, options);
  }

  setDisplayName(displayName: string, options?: CommandOptions): Promise<V1CommandResult> {
    return this.#sendTarget({ name: "set_display_name", payload: { display_name: displayName } }, options);
  }

  setAdmissionPolicy(policy: V1AdmissionPolicy, options?: CommandOptions): Promise<V1CommandResult> {
    return this.#sendTarget({ name: "set_admission_policy", payload: { policy } }, options);
  }

  assignRole(participantId: string, role: V1AssignableRole, options?: CommandOptions): Promise<V1CommandResult> {
    return this.#sendTarget({ name: "assign_roles", payload: { participant_id: participantId, role } }, options);
  }

  admit(admissionRequestId: string, options?: CommandOptions): Promise<V1CommandResult> {
    return this.#sendOperation((commandId) => ({ type: "operation", command_id: commandId, name: "admit_participant", payload: { admission_request_id: admissionRequestId } }), options);
  }

  deny(admissionRequestId: string, options?: CommandOptions): Promise<V1CommandResult> {
    return this.#sendOperation((commandId) => ({ type: "operation", command_id: commandId, name: "deny_admission", payload: { admission_request_id: admissionRequestId } }), options);
  }

  muteParticipant(participantId: string, options?: CommandOptions): Promise<V1CommandResult> {
    return this.#sendOperation((commandId) => ({ type: "operation", command_id: commandId, name: "mute_participant", payload: { participant_id: participantId } }), options);
  }

  stopParticipantCamera(participantId: string, options?: CommandOptions): Promise<V1CommandResult> {
    return this.#sendOperation((commandId) => ({ type: "operation", command_id: commandId, name: "stop_participant_camera", payload: { participant_id: participantId } }), options);
  }

  stopParticipantScreenShare(participantId: string, options?: CommandOptions): Promise<V1CommandResult> {
    return this.#sendOperation((commandId) => ({ type: "operation", command_id: commandId, name: "stop_participant_screen_share", payload: { participant_id: participantId } }), options);
  }

  removeParticipant(participantId: string, options?: CommandOptions): Promise<V1CommandResult> {
    return this.#sendOperation((commandId) => ({ type: "operation", command_id: commandId, name: "remove_participant", payload: { participant_id: participantId } }), options);
  }

  startRecording(options?: CommandOptions & { readonly recordingId?: string }): Promise<{ readonly recordingId: string; readonly result: V1CommandResult }> {
    const recordingId = options?.recordingId ?? this.#nextRequestId();
    return this.#sendOperation((commandId) => ({ type: "operation", command_id: commandId, name: "start_recording", payload: { recording_id: recordingId } }), options).then((result) => ({ recordingId, result }));
  }

  stopRecording(recordingId: string, options?: CommandOptions): Promise<V1CommandResult> {
    return this.#sendOperation((commandId) => ({ type: "operation", command_id: commandId, name: "stop_recording", payload: { recording_id: recordingId } }), options);
  }

  leave(options?: CommandOptions): Promise<V1CommandResult> {
    return this.#sendOperation((commandId) => ({ type: "operation", command_id: commandId, name: "participant_leave", payload: {} }), options);
  }

  endEpisode(options?: CommandOptions): Promise<V1CommandResult> {
    return this.#sendOperation((commandId) => ({ type: "operation", command_id: commandId, name: "end_episode", payload: {} }), options);
  }

  extendEpisode(minutes: number, options?: CommandOptions): Promise<V1CommandResult> {
    if (!Number.isSafeInteger(minutes) || minutes < 1) throw new V1SyncError("episode extension must be a positive whole number of minutes", "invalid_payload");
    return this.#sendOperation((commandId) => ({ type: "operation", command_id: commandId, name: "extend_episode", payload: { extension_seconds: minutes * 60 } }), options);
  }

  setMicrophoneEnabled(enabled: boolean, options?: RequestOptions): Promise<V1SelfMediaTargetResult> {
    return this.#sendLiveTarget("set_microphone_enabled", "microphone", enabled, options);
  }

  setCameraEnabled(enabled: boolean, options?: RequestOptions): Promise<V1SelfMediaTargetResult> {
    return this.#sendLiveTarget("set_camera_enabled", "camera", enabled, options);
  }

  setScreenShareEnabled(enabled: boolean, options?: RequestOptions): Promise<V1SelfMediaTargetResult> {
    return this.#sendLiveTarget("set_screen_share_enabled", "screen", enabled, options);
  }

  requestUnmute(participantId: string, options?: RequestOptions): Promise<V1DirectedRequestResult> {
    return this.#sendDirectedRequest("request_unmute", participantId, options);
  }

  requestStartCamera(participantId: string, options?: RequestOptions): Promise<V1DirectedRequestResult> {
    return this.#sendDirectedRequest("request_start_camera", participantId, options);
  }

  async #sendTarget(command: V1TargetCommand, options?: CommandOptions): Promise<V1CommandResult> {
    return this.#commandScheduler.sendTarget(command, this.#liveTargets.pendingCount + this.#requests.size, options);
  }

  #sendOperation(createFrame: V1OperationFrameFactory, options?: CommandOptions): Promise<V1CommandResult> {
    return this.#commandScheduler.sendOperation(createFrame, this.#liveTargets.pendingCount + this.#requests.size, options);
  }

  #sendLiveTarget(name: "set_microphone_enabled" | "set_camera_enabled" | "set_screen_share_enabled", source: V1MediaSource, enabled: boolean, options?: RequestOptions): Promise<V1SelfMediaTargetResult> {
    return this.#liveTargets.send(name, source, enabled, options);
  }

  #sendDirectedRequest(name: "request_unmute" | "request_start_camera", participantId: string, options?: RequestOptions): Promise<V1DirectedRequestResult> {
    this.#assertCapacity();
    if (this.#phase.phase !== "live") return Promise.reject(new V1SyncError("directed requests are live-only and are never queued for replay", "not_live"));
    const requestId = options?.requestId ?? this.#nextRequestId();
    if (this.#requests.has(requestId) || this.#liveTargets.has(requestId)) throw new V1SyncError("request ID is already pending", "request_id_conflict");
    const frame = { type: "directed_request", request_id: requestId, name, target_participant_id: participantId } as const;
    encodeV1ClientFrame(frame);
    const promise = new Promise<V1DirectedRequestResult>((resolve, reject) => this.#requests.set(requestId, { resolve, reject, settled: false, frame }));
    this.#send(frame);
    return promise;
  }

  #connect(): void {
    if (!this.#started || !this.#transportAvailable || this.#socket) return;
    this.#phase = { phase: "connecting" };
    this.#emit();
    const socket = this.#options.webSocket.connect(this.#options.url);
    const connectionGeneration = ++this.#connectionGeneration;
    this.#socket = socket;
    socket.onopen = () => void this.#authenticate(socket);
    socket.onmessage = (event) => {
      this.#inbound = this.#inbound.then(() => this.#receive(socket, event.data));
    };
    socket.onclose = () => {
      this.#clock().setTimeout(() => {
        if (connectionGeneration !== this.#connectionGeneration) return;
        this.#inbound = this.#inbound.then(() => this.#disconnected(socket));
      }, 0);
    };
    socket.onerror = () => socket.close(CLIENT_RESTART_CLOSE_CODE, "transport error");
  }

  async #authenticate(socket: V1Socket): Promise<void> {
    try {
      const token = await this.#options.token();
      if (socket !== this.#socket) return;
      this.#phase = { phase: "recovering" };
      const hello = {
        type: "hello",
        protocol: 1,
        token,
        streams: {
          control: { cursor: this.#control && { revision: this.#control.revision, state_schema_version: this.#control.stateSchemaVersion, state_digest: this.#control.stateDigest } },
          media: { cursor: null },
          presence: { cursor: null },
          requests: { cursor: null },
        },
        ...(this.#options.telemetry ? syncTelemetryCorrelation(this.#options.telemetry) : {}),
      } as const;
      const collaborationExtension = this.#collaborationState.helloExtension;
      if (!collaborationExtension) {
        this.#send(hello);
      } else {
        this.#send({ ...hello, extensions: [collaborationExtension] });
      }
      this.#emit();
    } catch {
      socket.close(CLIENT_RESTART_CLOSE_CODE, "authentication failed");
    }
  }

  async #receive(socket: V1Socket, data: unknown): Promise<void> {
    if (socket !== this.#socket) return;
    try {
      if (typeof data !== "string" || encoder.encode(data).byteLength > SyncProtocolLimits.snapshotEncodedBytes) throw new V1ReplicaError("invalid inbound frame size");
      await this.#handleFrame(decodeV1ServerFrame(data));
    } catch {
      this.#recover("invalid_frame");
    }
  }

  async #handleFrame(frame: SyncV1ServerFrame): Promise<void> {
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
          if (this.#controlEvents.get(frame.revision) !== frameSignature(frame)) throw new V1ReplicaError("conflicting or unprovable duplicate control event");
        } else {
          this.#control = await applyV1Event(this.#requireControl(), frame);
          this.#rememberControlHead(this.#control.revision, this.#control.stateDigest);
          this.#rememberControlEvent(frame);
        }
        await this.#commandScheduler.settleTerminalLifecycle(frame, this.#participantId);
        await this.#commandScheduler.settleProven();
        {
          const control = this.#requireControl();
          this.#send({ type: "delivery_ack", stream: "control", revision: control.revision, state_digest: control.stateDigest });
        }
        this.#emit();
        return;
      case "ack":
        this.#requireLive();
        await this.#commandScheduler.acknowledge(frame);
        return;
      case "retryable_error":
        this.#requireLive();
        this.#commandScheduler.retry(frame.command_id, frame.code);
        return;
      case "live_target_result":
        this.#liveTargets.receive(frame);
        return;
      case "directed_request_result":
        this.#requestResult(frame);
        return;
      case "directed_request":
        this.#directedRequest(frame);
        return;
      case "reaction":
        this.#collaborationState.reaction(frame);
        return;
      case "reaction_result":
        this.#collaborationState.reactionResult(frame);
        return;
      case "chat_message":
        this.#collaborationState.chatMessage(frame);
        return;
      case "chat_send_result":
        this.#collaborationState.chatSendResult(frame);
        return;
      case "chat_page":
        this.#collaborationState.chatPage(frame);
        return;
      case "chat_head":
        this.#collaborationState.chatHead(frame);
        return;
      case "chat_read_receipt":
        this.#collaborationState.chatReadReceipt(frame);
        return;
      case "chat_read_result":
        this.#collaborationState.chatReadResult(frame);
        return;
      case "error":
        throw new V1ReplicaError(frame.code);
      case "pong":
        this.#requireLive();
        this.#missedHeartbeats = 0;
        return;
    }
  }

  async #welcome(frame: Extract<SyncV1ServerFrame, { readonly type: "welcome" }>): Promise<void> {
    if (this.#phase.phase !== "recovering" || this.#recovery) throw new V1ReplicaError("unexpected welcome");
    this.#collaborationState.acceptWelcome(frame);
    this.#participantId = frame.participant_id;
    this.#participantGeneration = frame.participant_generation;
    this.#updateLocalMediaStates();
    if (frame.mode === "terminal") {
      await this.#commandScheduler.settleTerminalRecovery(frame);
      this.#phase = { phase: "terminal", terminalReason: frame.reason };
      this.#socket?.close(1000, "terminal recovery");
      this.#emit();
      return;
    }
    if (frame.mode === "snapshot") {
      this.#control = await restoreV1Snapshot(frame.snapshot);
      this.#controlHeads.clear();
      this.#controlEvents.clear();
      this.#rememberControlHead(this.#control.revision, this.#control.stateDigest);
    }
    if (frame.mode === "replay" && (!this.#control || this.#control.revision >= frame.head.revision)) throw new V1ReplicaError("invalid replay welcome");
    if (frame.mode === "up_to_date" && !sameHead(this.#control, frame.head)) throw new V1ReplicaError("up-to-date head mismatch");
    if (frame.mode === "snapshot" && !sameHead(this.#control, frame.head)) throw new V1ReplicaError("snapshot head mismatch");
    this.#recovery = { id: frame.recovery_id, head: frame.head, replayEvents: 0, replayBytes: 0, controlComplete: false };
    if (frame.mode !== "replay") this.#ackRecovery();
    this.#emit();
  }

  async #replay(frame: Extract<SyncV1ServerFrame, { readonly type: "replay_page" }>): Promise<void> {
    const recovery = this.#requireRecovery();
    if (frame.recovery_id !== recovery.id || frame.first_revision !== this.#requireControl().revision + 1) throw new V1ReplicaError("replay page is not exact-next");
    recovery.replayEvents += frame.events.length;
    recovery.replayBytes += encoder.encode(JSON.stringify(frame.events)).byteLength;
    if (recovery.replayEvents > MAX_REPLAY_EVENTS || recovery.replayBytes > MAX_REPLAY_BYTES) throw new V1ReplicaError("replay exceeds client bounds");
    for (const event of frame.events) {
      this.#control = await applyV1Event(this.#requireControl(), event);
      this.#rememberControlHead(this.#control.revision, this.#control.stateDigest);
      this.#rememberControlEvent(event);
    }
    this.#ackRecovery();
    this.#emit();
  }

  #completeRecovery(frame: Extract<SyncV1ServerFrame, { readonly type: "recovery_complete" }>): void {
    const recovery = this.#requireRecovery();
    if (frame.recovery_id !== recovery.id || !sameHead(this.#control, frame.head) || !sameRawHead(recovery.head, frame.head)) throw new V1ReplicaError("recovery completed at the wrong head");
    recovery.controlComplete = true;
    this.#enterLiveIfReady();
  }

  #replaceProjection(frame: Extract<SyncV1ServerFrame, { readonly type: "projection_snapshot" }>): void {
    if (this.#phase.phase !== "recovering" && this.#phase.phase !== "live") throw new V1ReplicaError("projection snapshot arrived in the wrong phase");
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

  #applyProjection(frame: Extract<SyncV1ServerFrame, { readonly type: "projection_event" }>): void {
    this.#requireLive();
    if (frame.stream === "media") {
      if (this.#acceptProjectionDuplicate(this.#media, this.#mediaEventEvidence, frame)) return;
      this.#media = updateProjection(this.#media, frame.projection_id, frame.sequence, mediaItem(frame.item), mediaKey);
      rememberBoundedEvidence(this.#mediaEventEvidence, frame.sequence, frameSignature(frame), MAX_PROJECTION_EVENT_EVIDENCE);
    } else {
      if (this.#acceptProjectionDuplicate(this.#presence, this.#presenceEventEvidence, frame)) return;
      this.#presence = updateProjection(this.#presence, frame.projection_id, frame.sequence, presenceItem(frame.item), (item) => item.participantId);
      rememberBoundedEvidence(this.#presenceEventEvidence, frame.sequence, frameSignature(frame), MAX_PROJECTION_EVENT_EVIDENCE);
    }
    this.#emit();
  }

  #requestResult(frame: V1DirectedRequestResult): void {
    this.#requireLive();
    const deferred = this.#requests.get(frame.request_id);
    if (!deferred) return;
    this.#requests.delete(frame.request_id);
    resolveDeferred(deferred, frame);
  }

  #directedRequest(frame: V1DirectedRequest): void {
    this.#requireLive();
    if (frame.expires_at_ms <= this.#now()) return;
    this.#send({ type: "request_ack", request_id: frame.request_id });
    for (const listener of this.#requestListeners) listener(frame);
  }

  #enterLiveIfReady(): void {
    if (!this.#recovery?.controlComplete || !this.#media || !this.#presence) return;
    this.#recovery = null;
    this.#phase = { phase: "live" };
    this.#reconnectAttempt = 0;
    this.#missedHeartbeats = 0;
    this.#commandScheduler.enterLive();
    this.#liveTargets.enterLive();
    this.#startHeartbeat();
    this.#emit();
  }

  #ackRecovery(): void {
    const recovery = this.#requireRecovery();
    const control = this.#requireControl();
    this.#send({ type: "recovery_ack", recovery_id: recovery.id, revision: control.revision, state_digest: control.stateDigest });
  }

  #ackHeadIsProven(ack: Extract<V1CommandResult, { readonly outcome: "committed" | "satisfied" }>): boolean {
    return this.#controlHeads.get(ack.revision) === ack.state_digest;
  }

  #rememberControlHead(revision: number, digest: string): void {
    this.#controlHeads.set(revision, digest);
    if (this.#controlHeads.size <= MAX_REPLAY_EVENTS) return;
    const oldest = this.#controlHeads.keys().next().value;
    if (oldest !== undefined) this.#controlHeads.delete(oldest);
  }

  #rememberControlEvent(event: Extract<SyncV1ServerFrame, { readonly type: "event" }>): void {
    rememberBoundedEvidence(this.#controlEvents, event.revision, frameSignature(event), MAX_REPLAY_EVENTS);
  }

  #acceptProjectionDuplicate<T>(projection: V1Projection<T> | null, evidence: ReadonlyMap<number, string>, frame: Extract<SyncV1ServerFrame, { readonly type: "projection_event" }>): boolean {
    if (!projection || frame.projection_id !== projection.projectionId || frame.sequence > projection.sequence) return false;
    if (evidence.get(frame.sequence) !== frameSignature(frame)) throw new V1ReplicaError("conflicting or unprovable duplicate projection event");
    return true;
  }

  #disconnected(socket: V1Socket): void {
    if (socket !== this.#socket) return;
    this.#socket = null;
    this.#recovery = null;
    this.#clearHeartbeat();
    this.#liveTargets.disconnect("disconnected_before_delivery");
    this.#commandScheduler.disconnect();
    this.#media = null;
    this.#presence = null;
    this.#rejectRequests("disconnected_before_delivery");
    this.#collaborationState.disconnect("disconnected_before_delivery");
    if (!this.#started || !this.#transportAvailable || this.#phase.phase === "terminal") return;
    this.#phase = { phase: "connecting" };
    this.#emit();
    this.#clearReconnect();
    const configuredDelay = this.#options.reconnectDelayMs;
    const delay = configuredDelay === 0 ? 0 : Math.min(MAX_RECONNECT_DELAY_MS, (configuredDelay ?? DEFAULT_RECONNECT_DELAY_MS) * 2 ** Math.min(this.#reconnectAttempt, 5));
    this.#reconnectAttempt += 1;
    this.#reconnectTimer = this.#clock().setTimeout(() => {
      this.#reconnectTimer = undefined;
      this.#connect();
    }, delay);
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
    this.#liveTargets.disconnect(code);
  }

  #rejectRequests(code: string): void {
    for (const deferred of this.#requests.values()) rejectDeferred(deferred, new V1SyncError(code, code));
    this.#requests.clear();
  }

  #sendIfLive(frame: SyncV1ClientFrame): void {
    if (this.#phase.phase === "live") this.#send(frame);
  }

  #send(frame: SyncV1ClientFrame): void {
    this.#socket?.send(encodeV1ClientFrame(frame));
  }

  #requireLive(): void {
    if (this.#phase.phase !== "live") throw new V1ReplicaError("live frame arrived before four-stream recovery completed");
  }

  #requireControl(): V1ControlState {
    if (!this.#control) throw new V1ReplicaError("control replica is unavailable");
    return this.#control;
  }

  #requireRecovery(): Recovery {
    if (!this.#recovery || this.#phase.phase !== "recovering") throw new V1ReplicaError("recovery frame arrived outside recovery");
    return this.#recovery;
  }

  #assertCapacity(): void {
    this.#commandScheduler.assertCapacity(this.#liveTargets.pendingCount + this.#requests.size);
  }

  #nextRequestId(): string {
    return this.#options.requestIds?.next() ?? crypto.randomUUID();
  }

  #clock(): NonNullable<V1SyncClientOptions["clock"]> {
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

  #subscribeMediaPlane(mediaPlane: ClientMediaPlane | undefined): void {
    if (!mediaPlane) return;
    try {
      this.#unsubscribeLocalMedia = mediaPlane.observeLocalPublications((publications) => this.#replaceMediaPlanePublications("local", publications));
      this.#unsubscribeRemoteMedia = mediaPlane.observeRemotePublications((publications) => this.#replaceMediaPlanePublications("remote", publications));
    } catch {
      this.#unsubscribeMediaPlane();
      this.#started = false;
      throw new V1SyncError("unable to observe the client MediaPlane", "media_plane_unavailable");
    }
  }

  #unsubscribeMediaPlane(): void {
    this.#unsubscribeLocalMedia?.();
    this.#unsubscribeRemoteMedia?.();
    this.#unsubscribeLocalMedia = undefined;
    this.#unsubscribeRemoteMedia = undefined;
  }

  #replaceMediaPlanePublications(kind: "local" | "remote", publications: readonly V1MediaPublication[]): void {
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
    this.#liveTargets.updateFromPublications(this.#localPublications);
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

function updateProjection<T>(projection: V1Projection<T> | null, projectionId: string, sequence: number, item: T, key: (item: T) => string): V1Projection<T> {
  if (!projection || projection.projectionId !== projectionId) throw new V1ReplicaError("projection event has no matching replace snapshot");
  if (sequence !== projection.sequence + 1) throw new V1ReplicaError("projection event is not exact-next");
  const itemKey = key(item);
  return { projectionId, sequence, items: [...projection.items.filter((candidate) => key(candidate) !== itemKey), item] };
}

function mediaItem(item: { readonly participant_id: string; readonly source: V1MediaSource; readonly enabled: boolean; readonly publication_id: string | null }): V1MediaPublication {
  return { participantId: item.participant_id, source: item.source, enabled: item.enabled, publicationId: item.publication_id };
}

function presenceItem(item: { readonly participant_id: string; readonly state: "connected" | "disconnected"; readonly speaking: boolean; readonly active_speaker: boolean }): V1Presence {
  return { participantId: item.participant_id, state: item.state, speaking: item.speaking, activeSpeaker: item.active_speaker };
}

function mediaKey(item: V1MediaPublication): string {
  return `${item.participantId}:${item.source}`;
}

function sameHead(control: V1ControlState | null, head: { readonly revision: number; readonly state_schema_version: number; readonly state_digest: string }): boolean {
  return control !== null && control.revision === head.revision && control.stateSchemaVersion === head.state_schema_version && control.stateDigest === head.state_digest;
}

function sameRawHead(left: Recovery["head"], right: Recovery["head"]): boolean {
  return left.revision === right.revision && left.state_schema_version === right.state_schema_version && left.state_digest === right.state_digest;
}

function copyProjection<T>(projection: V1Projection<T> | null): V1Projection<T> | null {
  return projection && { ...projection, items: projection.items.map((item) => ({ ...item })) };
}

function rememberBoundedEvidence(evidence: Map<number, string>, sequence: number, signature: string, capacity: number): void {
  evidence.set(sequence, signature);
  if (evidence.size <= capacity) return;
  const oldest = evidence.keys().next().value;
  if (oldest !== undefined) evidence.delete(oldest);
}

function copyPublication(publication: V1MediaPublication): V1MediaPublication {
  return { ...publication };
}

function validMediaPublication(publication: V1MediaPublication): boolean {
  return (
    typeof publication.participantId === "string" &&
    publication.participantId.length > 0 &&
    (publication.source === "microphone" || publication.source === "camera" || publication.source === "screen") &&
    typeof publication.enabled === "boolean" &&
    (publication.publicationId === null || typeof publication.publicationId === "string") &&
    publication.enabled === (publication.publicationId !== null)
  );
}

function assertV1Url(value: string): void {
  const url = new URL(value);
  if (url.pathname !== "/v1/sync") throw new V1SyncError("SyncEngine v1 websocket URL must use /v1/sync", "invalid_url");
}
