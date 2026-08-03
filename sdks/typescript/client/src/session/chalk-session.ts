import type { CloudflareSFUSnapshot } from "../media";
import type { ChalkChatFileTransport } from "../chat-files";
import type { V1SessionSnapshot } from "../sync";
import type { V1DirectedRequest, V1RoomActionClientEvent, V1RoomActionsExtensionState } from "../sync/v1-types";
import { ParticipantAccessError } from "./access";
import type { ParticipantAccessSubject } from "./access";
import { ChalkSessionAccessManager } from "./access-manager";
import type { ChalkSessionDiagnostic, ChalkSessionJoinTraceEvent, ChalkSessionJoinTraceStep } from "./diagnostics";
import { ChalkSessionDiagnostics } from "./diagnostics";
import type { ChalkSessionAccessProvider, ChalkSessionDependencies, ChalkSessionMediaClient, ChalkSessionSyncClient } from "./dependencies";
import { requireDisplayVideoTrack, stopStream, streamFromTracks } from "./media-devices";
import { createDefaultChalkSessionDependencies } from "./production";
import { initialChalkSessionSnapshot, projectChalkSessionSnapshot } from "./snapshot";
import { ChalkSessionError } from "./types";
import type {
  ChalkAdmissionPolicy,
  ChalkAssignableParticipantRole,
  ChalkChatMessage,
  ChalkChatPageResult,
  ChalkChatReadReceipt,
  ChalkChatState,
  ChalkDirectedRequestResult,
  ChalkIncomingMediaRequest,
  ChalkMediaSource,
  ChalkReaction,
  ChalkRoomReaction,
  ChalkSendChatMessageInput,
  ChalkSessionActionName,
  ChalkSessionErrorCode,
  ChalkSessionFailure,
  ChalkSessionSnapshot,
  ChalkSessionState,
  ChalkSessionStore,
  ChalkWhiteboardV1Transport,
  ChalkWhiteboardSummary,
} from "./types";
import { CHALK_CHAT_ATTACHMENT_LIMITS, CHALK_CHAT_ATTACHMENT_MIME_TYPES } from "../room-actions/types";

const START_TIMEOUT_MS = 10_000;
const LEAVE_TIMEOUT_MS = 5_000;
const RECOVERY_BUDGET_MS = 10_000;
const MAX_RECOVERY_ATTEMPTS = 3;
const REFRESH_RETRY_MS = 5_000;
const DEFAULT_CHAT_PAGE_SIZE = 50;
const MAX_CHAT_PAGE_SIZE = 100;
const MAX_LOADED_CHAT_MESSAGES = 500;
const MAX_VISIBLE_REACTIONS = 24;
const MAX_CHAT_TEXT_BYTES = 16_384;
const MAX_CHAT_TEXT_SCALARS = 4_000;
const chatEncoder = new TextEncoder();
const allowedChatAttachmentMimeTypes = new Set<string>(CHALK_CHAT_ATTACHMENT_MIME_TYPES);

type RecoveryKind = "sync" | "media";
type SyncRuntimeFailure = {
  readonly code: "invalid_access" | "session_ended";
  readonly message: string;
};
type ChatCatchUpRequest =
  | {
      readonly kind: "initial";
      readonly input: { readonly limit: number };
    }
  | {
      readonly kind: "newer";
      readonly input: { readonly afterSequence: string; readonly limit: number };
    };
type ChatCatchUpStep = "continue" | "stop";

export type ChalkSessionOptions = {
  readonly access: ChalkSessionAccessProvider;
  readonly syncURL: string;
  readonly apiBaseURL: string;
  readonly whiteboardURL?: string | null;
  readonly syncStartupTimeoutMs?: number;
  readonly initialMicrophoneEnabled?: boolean;
  readonly initialCameraEnabled?: boolean;
  readonly accessRefreshWindowMs?: number;
  readonly recovery?: {
    readonly maxAttempts?: number;
    readonly budgetMs?: number;
    readonly backoffMs?: readonly number[];
  };
  readonly diagnostics?: {
    readonly limit?: number;
    readonly onEvent?: (event: ChalkSessionDiagnostic) => void;
  };
  readonly dependencies?: Partial<ChalkSessionDependencies>;
};

export class ChalkSession implements ChalkSessionStore {
  readonly chatFiles: ChalkChatFileTransport | null;
  readonly whiteboard: ChalkWhiteboardV1Transport | null;
  readonly #access: ChalkSessionAccessManager;
  readonly #dependencies: ChalkSessionDependencies;
  readonly #diagnostics: ChalkSessionDiagnostics;
  readonly #listeners = new Set<() => void>();
  readonly #localTracks = new Map<ChalkMediaSource, MediaStreamTrack>();
  readonly #mediaCommandTails = new Map<ChalkMediaSource, Promise<void>>();
  readonly #sleeps = new Set<{ readonly handle: unknown; readonly resolve: () => void }>();
  readonly #maxRecoveryAttempts: number;
  readonly #recoveryBackoffMs: readonly number[];
  readonly #recoveryBudgetMs: number;
  readonly #syncStartupTimeoutMs: number;
  readonly #localIntent: Record<"microphone" | "camera", boolean>;
  #epoch = 0;
  #failure: ChalkSessionFailure | null = null;
  #failedCleanupRequired = false;
  #joinCleanupConfirmed: boolean | null = null;
  #joinPromise: Promise<void> | null = null;
  #leavePromise: Promise<void> | null = null;
  #media: ChalkSessionMediaClient | null = null;
  #mediaSnapshot: CloudflareSFUSnapshot | null = null;
  #pendingRecovery: RecoveryKind | null = null;
  #recoveryPromise: Promise<void> | null = null;
  #refreshTimer: unknown;
  #screenEndedPending = false;
  #sessionEndConfirmed = false;
  #snapshot = initialChalkSessionSnapshot();
  #state: ChalkSessionState = "idle";
  #sync: ChalkSessionSyncClient | null = null;
  #syncRecoveryTimer: unknown;
  #syncSnapshot: V1SessionSnapshot | null = null;
  #teardownPromise: Promise<boolean> | null = null;
  #unsubscribeMedia: (() => void) | null = null;
  #unsubscribeRequests: (() => void) | null = null;
  #unsubscribeRoomActions: (() => void) | null = null;
  #unsubscribeSync: (() => void) | null = null;
  #reactions: readonly ChalkRoomReaction[] = [];
  #chat: ChalkChatState = emptyChatState();
  #chatCatchUpPromise: Promise<void> | null = null;
  #chatCatchUpRequested = false;
  #incomingMediaRequests: readonly ChalkIncomingMediaRequest[] = [];
  #whiteboardSummary: ChalkWhiteboardSummary = emptyWhiteboardSummary();
  readonly #reactionTimers = new Map<string, unknown>();
  readonly #mediaRequestTimers = new Map<string, unknown>();

  constructor(options: ChalkSessionOptions) {
    if (!options.access) throw new TypeError("A participant access provider is required");
    const defaults = createDefaultChalkSessionDependencies({ apiBaseURL: options.apiBaseURL, syncURL: options.syncURL, whiteboardURL: options.whiteboardURL });
    this.#dependencies = { ...defaults, ...options.dependencies };
    this.#access = new ChalkSessionAccessManager(options.access, this.#dependencies.clock.now, options.accessRefreshWindowMs);
    this.chatFiles = this.#createChatFileTransport();
    this.whiteboard = this.#createWhiteboardClient();
    this.#localIntent = {
      microphone: options.initialMicrophoneEnabled ?? true,
      camera: options.initialCameraEnabled ?? true,
    };
    this.#maxRecoveryAttempts = boundedInteger(options.recovery?.maxAttempts, MAX_RECOVERY_ATTEMPTS, 1, 10);
    this.#recoveryBudgetMs = boundedInteger(options.recovery?.budgetMs, RECOVERY_BUDGET_MS, 1, 60_000);
    this.#syncStartupTimeoutMs = boundedInteger(options.syncStartupTimeoutMs, START_TIMEOUT_MS, 1, 60_000);
    this.#recoveryBackoffMs = options.recovery?.backoffMs?.length ? [...options.recovery.backoffMs] : [100, 250, 500];
    this.#diagnostics = new ChalkSessionDiagnostics({ now: this.#dependencies.clock.now, ...options.diagnostics });
  }

  #createChatFileTransport(): ChalkChatFileTransport | null {
    const create = this.#dependencies.createChatFileTransport;
    if (!create) return null;
    return create({ token: () => this.#access.getSyncToken() });
  }

  #createWhiteboardClient(): ChalkWhiteboardV1Transport | null {
    const create = this.#dependencies.createWhiteboardClient;
    if (!create) return null;
    return create({
      token: () => this.#access.getSyncToken(),
      onSummary: (summary) => {
        this.#whiteboardSummary = summary;
        this.#publish();
      },
    });
  }

  getSnapshot = (): ChalkSessionSnapshot => this.#snapshot;

  getDiagnostics(): readonly ChalkSessionDiagnostic[] {
    return this.#diagnostics.snapshot();
  }

  getJoinTrace(): readonly ChalkSessionJoinTraceEvent[] {
    return this.#diagnostics.joinTrace();
  }

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  join = (): Promise<void> => {
    if (this.#state === "joining" && this.#joinPromise) return this.#joinPromise;
    if (this.#state === "live") return Promise.resolve();
    const blocker = this.#joinBlocker();
    if (blocker) return Promise.reject(this.#error("invalid_state", "join", false, blocker));

    this.#resetForJoin();
    const epoch = ++this.#epoch;
    this.#transition("joining");
    const promise = this.#performJoin(epoch).finally(() => {
      if (this.#joinPromise === promise) this.#joinPromise = null;
    });
    this.#joinPromise = promise;
    return promise;
  };

  #joinBlocker(): string | null {
    if (this.#state === "leaving" || this.#state === "reconnecting") return `Cannot join while ${this.#state}`;
    if (this.#state === "failed" && (this.#failedCleanupRequired || !this.#isFullyTornDown())) return "Cannot join until failed session cleanup completes";
    if (this.#state === "left" && this.#mediaCommandTails.size > 0) return "Cannot join until prior media commands settle";
    return null;
  }

  leave = (): Promise<void> => {
    if (this.#state === "idle" || this.#state === "left") return Promise.resolve();
    if (this.#state === "leaving" && this.#leavePromise) return this.#leavePromise;
    const wasJoining = this.#state === "joining";
    ++this.#epoch;
    this.#transition("leaving");
    const promise = (async () => {
      if (wasJoining) await this.#joinPromise?.catch(() => undefined);
      const confirmed = wasJoining && this.#joinCleanupConfirmed !== null ? this.#joinCleanupConfirmed : await this.#teardown(true);
      const failure = confirmed ? null : this.#failureValue("leave_unconfirmed", "leave", false, "The session left locally without a durable Leave acknowledgement");
      this.#failure = failure;
      this.#transition("left");
      if (failure) throw new ChalkSessionError(failure);
    })().finally(() => {
      if (this.#leavePromise === promise) this.#leavePromise = null;
    });
    this.#leavePromise = promise;
    return promise;
  };

  setMicrophoneEnabled = (enabled: boolean): Promise<void> => this.#setUserMediaEnabled("microphone", enabled);

  setCameraEnabled = (enabled: boolean): Promise<void> => this.#setUserMediaEnabled("camera", enabled);

  startScreenShare = (): Promise<void> => this.#serializeMediaCommand("screen", "startScreenShare", (epoch) => this.#runCommand("startScreenShare", () => this.#startScreenShare(epoch)));

  async #startScreenShare(epoch: number): Promise<void> {
    if (this.#localTracks.has("screen")) return;
    const media = this.#media!;
    const sync = this.#sync!;
    let stream: MediaStream | null = null;
    let prepared = false;
    try {
      stream = await this.#dependencies.mediaDevices.getDisplayMedia({ video: true, audio: false });
      this.#assertCommandEpoch(epoch, "startScreenShare");
      const track = requireDisplayVideoTrack(stream);
      this.#screenEndedPending = false;
      this.#localTracks.set("screen", track);
      media.prepareLocalTrack("screen", track);
      prepared = true;
      this.#publish();
      await sync.setScreenShareEnabled(true);
      this.#assertCommandEpoch(epoch, "startScreenShare");
    } catch (error) {
      if (prepared) await media.clearPreparedLocalTrack("screen").catch(() => undefined);
      else stopStream(stream);
      this.#localTracks.delete("screen");
      this.#publish();
      if (isPermissionDenied(error)) throw this.#error("permission_denied", "startScreenShare", true, "Screen sharing permission was denied", error);
      throw error;
    }
  }

  stopScreenShare = (): Promise<void> => this.#serializeMediaCommand("screen", "stopScreenShare", (epoch) => this.#stopScreenShare(epoch));

  #stopScreenShare(epoch: number): Promise<void> {
    if (!this.#localTracks.has("screen")) return Promise.resolve();
    return this.#runCommand("stopScreenShare", async () => {
      const sync = this.#sync!;
      const media = this.#media!;
      await sync.setScreenShareEnabled(false);
      this.#assertCommandEpoch(epoch, "stopScreenShare");
      await media.clearPreparedLocalTrack("screen");
      this.#assertCommandEpoch(epoch, "stopScreenShare");
      this.#localTracks.delete("screen");
      this.#publish();
    });
  }

  setHandRaised = (raised: boolean): Promise<void> => this.#runCommand("setHandRaised", () => this.#sync!.setHandRaised(raised));
  setDisplayName = (displayName: string): Promise<void> => this.#runCommand("setDisplayName", () => this.#sync!.setDisplayName(displayName));
  setAdmissionPolicy = (policy: ChalkAdmissionPolicy): Promise<void> => this.#runCommand("setAdmissionPolicy", () => this.#sync!.setAdmissionPolicy(policy));
  setParticipantRole = (participantSessionId: string, role: ChalkAssignableParticipantRole): Promise<void> => this.#runCommand("setParticipantRole", () => this.#sync!.setParticipantRole(participantSessionId, role));
  transferHost = (participantSessionId: string): Promise<void> => this.#runCommand("transferHost", () => this.#sync!.transferHost(participantSessionId));
  admitParticipant = (admissionRequestId: string): Promise<void> => this.#runCommand("admitParticipant", () => this.#sync!.admit(admissionRequestId));
  denyAdmission = (admissionRequestId: string): Promise<void> => this.#runCommand("denyAdmission", () => this.#sync!.deny(admissionRequestId));
  muteParticipant = (participantSessionId: string): Promise<void> => this.#runCommand("muteParticipant", () => this.#sync!.muteParticipant(participantSessionId));
  stopParticipantCamera = (participantSessionId: string): Promise<void> => this.#runCommand("stopParticipantCamera", () => this.#sync!.stopParticipantCamera(participantSessionId));
  stopParticipantScreenShare = (participantSessionId: string): Promise<void> => this.#runCommand("stopParticipantScreenShare", () => this.#sync!.stopParticipantScreenShare(participantSessionId));
  removeParticipant = (participantSessionId: string): Promise<void> => this.#runCommand("removeParticipant", () => this.#sync!.removeParticipant(participantSessionId));
  endSession = async (): Promise<void> => {
    await this.#runCommand("endSession", () => this.#sync!.endSession());
    this.#sessionEndConfirmed = true;
  };

  sendReaction = (reaction: ChalkReaction): Promise<ChalkRoomReaction> =>
    this.#runRoomAction("sendReaction", async () => {
      const accepted = await this.#sync!.sendReaction(reaction);
      this.#observeReaction(accepted);
      return accepted;
    });

  sendChatMessage = (input: ChalkSendChatMessageInput): Promise<ChalkChatMessage> => {
    const inputFailure = validateChatMessageInput(input);
    if (inputFailure) return Promise.reject(this.#error("invalid_payload", "sendChatMessage", false, inputFailure));
    const clientMessageId = input.clientMessageId ?? roomActionId();
    const attachments = input.attachments ?? [];
    this.#upsertPendingChat(clientMessageId, input.text, attachments, "sending", null);
    return this.#runRoomAction("sendChatMessage", () => this.#sync!.sendChatMessage({ text: input.text, attachments, clientMessageId }))
      .then((message) => {
        this.#removePendingChat(clientMessageId);
        this.#observeChatMessage(message, false);
        return message;
      })
      .catch((cause) => {
        const failure = failureFrom(cause instanceof ChalkSessionError ? cause : this.#roomActionError("sendChatMessage", cause));
        this.#upsertPendingChat(clientMessageId, input.text, attachments, "failed", failure);
        throw cause instanceof ChalkSessionError ? cause : new ChalkSessionError(failure, { cause });
      });
  };

  retryChatMessage = (clientMessageId: string): Promise<ChalkChatMessage> => {
    const pending = this.#chat.pending.find((message) => message.clientMessageId === clientMessageId);
    if (!pending) return Promise.reject(this.#error("invalid_payload", "retryChatMessage", false, "The failed chat message is no longer available"));
    return this.sendChatMessage({ clientMessageId, text: pending.text, attachments: pending.attachments });
  };

  loadOlderChatMessages = (limit = DEFAULT_CHAT_PAGE_SIZE): Promise<ChalkChatPageResult> =>
    this.#runRoomAction("loadOlderChatMessages", async () => {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_CHAT_PAGE_SIZE) {
        throw this.#error("invalid_payload", "loadOlderChatMessages", false, `Chat page size must be between 1 and ${MAX_CHAT_PAGE_SIZE}`);
      }
      const beforeSequence = this.#chat.messages[0]?.sequence;
      this.#chat = { ...this.#chat, status: "loading", error: null };
      this.#publish();
      const result = await this.#sync!.readChatPage({ beforeSequence, limit });
      if (result.status === "cursor_reset") {
        this.#chat = {
          ...this.#chat,
          status: "ready",
          historyTruncated: true,
          retainedFloorSequence: result.retainedFloorSequence,
          hasOlder: false,
        };
      } else {
        this.#chat = { ...this.#chat, status: "ready", hasOlder: result.hasOlder };
      }
      this.#publish();
      return result;
    }).catch((cause) => {
      const failure = failureFrom(cause instanceof ChalkSessionError ? cause : this.#roomActionError("loadOlderChatMessages", cause));
      this.#chat = { ...this.#chat, status: "failed", error: failure };
      this.#publish();
      throw cause instanceof ChalkSessionError ? cause : new ChalkSessionError(failure, { cause });
    });

  markChatRead = (throughSequence?: string): Promise<ChalkChatReadReceipt | null> => {
    const sequence = throughSequence ?? this.#chat.messages.at(-1)?.sequence;
    if (!sequence) return Promise.resolve(null);
    const latestSequence = this.#chat.messages.at(-1)?.sequence;
    if (latestSequence && compareSequence(sequence, latestSequence) > 0) {
      return Promise.reject(this.#error("invalid_payload", "markChatRead", false, "Chat cannot be marked beyond the latest loaded message"));
    }
    this.#applyLocalReadThrough(sequence);
    this.#publish();
    if (this.#sync?.getRoomActionsExtensionState().version !== 2) return Promise.resolve(null);
    return this.#runRoomAction("markChatRead", () => this.#sync!.markChatRead(sequence)).then((receipt) => {
      if (this.#mergeChatReadReceipt(receipt)) this.#publish();
      return receipt;
    });
  };

  requestUnmute = (participantSessionId: string): Promise<ChalkDirectedRequestResult> => this.#runRoomAction("requestUnmute", async () => directedRequestResult(await this.#sync!.requestUnmute(participantSessionId)));

  requestStartCamera = (participantSessionId: string): Promise<ChalkDirectedRequestResult> => this.#runRoomAction("requestStartCamera", async () => directedRequestResult(await this.#sync!.requestStartCamera(participantSessionId)));

  acceptMediaRequest = (requestId: string): Promise<void> =>
    this.#runRoomAction("acceptMediaRequest", async () => {
      const request = this.#incomingMediaRequests.find((candidate) => candidate.requestId === requestId);
      if (!request) throw this.#error("invalid_payload", "acceptMediaRequest", false, "The media request is no longer active");
      if (request.kind === "unmute") await this.setMicrophoneEnabled(true);
      else await this.setCameraEnabled(true);
      this.#removeMediaRequest(requestId);
    });

  declineMediaRequest = (requestId: string): void => {
    this.#removeMediaRequest(requestId);
  };

  async #performJoin(epoch: number): Promise<void> {
    let stream: MediaStream | null = null;
    const joinSpan = this.#diagnostics.startSpan({ step: "join", state: this.#state, epoch });
    try {
      stream = await this.#runJoinTraceStep(epoch, joinSpan.spanId, "acquire_initial_media", () => this.#acquireInitialMedia());
      this.#assertEpoch(epoch);
      const access = await this.#runJoinTraceStep(epoch, joinSpan.spanId, "access_initialize", () => this.#access.initialize());
      this.#assertEpoch(epoch);
      try {
        this.#media = await this.#runJoinTraceStep(epoch, joinSpan.spanId, "create_media_client", () =>
          this.#dependencies.createMediaClient({
            access,
            credential: () => this.#access.getMediaToken(),
            onFailure: () => this.#handleMediaFailure(),
            onScreenEnded: () => this.#handleScreenEnded(),
          }),
        );
      } catch (cause) {
        throw new StartupFailure("media", cause);
      }
      try {
        this.#sync = await this.#runJoinTraceStep(epoch, joinSpan.spanId, "create_sync_client", () => this.#dependencies.createSyncClient({ access, token: () => this.#access.getSyncToken(), media: this.#media! }));
      } catch (cause) {
        throw new StartupFailure("sync", cause);
      }
      this.#subscribeLowerLayers();
      const media = this.#media;
      const sync = this.#sync;
      const syncStartup = this.#runJoinTraceStep(epoch, joinSpan.spanId, "start_sync", async () => {
        try {
          await sync.start();
        } catch (cause) {
          throw new StartupFailure("sync", cause);
        }
      });
      const syncReady = syncStartup.then(() =>
        this.#runJoinTraceStep(epoch, joinSpan.spanId, "wait_for_sync_live", async () => {
          try {
            await this.#waitForSyncLive(sync, this.#syncStartupTimeoutMs);
          } catch (cause) {
            throw new StartupFailure("sync", cause);
          }
        }),
      );
      await Promise.all([
        this.#runJoinTraceStep(epoch, joinSpan.spanId, "start_media", () =>
          media.start(stream!).catch((cause) => {
            throw new StartupFailure("media", cause);
          }),
        ),
        syncReady,
      ]);
      this.#assertEpoch(epoch);
      this.#failure = null;
      this.#transition("live");
      this.#scheduleAccessRefresh();
      joinSpan.end({ state: this.#state, epoch: this.#epoch, outcome: "succeeded" });
    } catch (cause) {
      if (!this.#media) stopStream(stream);
      const cancelled = cause instanceof StaleEpoch;
      const confirmed = await this.#teardown(this.#access.current !== null);
      this.#joinCleanupConfirmed = confirmed;
      if (!confirmed) this.#diagnostics.record({ event: "cleanup_unconfirmed", state: this.#state, epoch: this.#epoch, code: "join_cleanup_unconfirmed" });
      if (cancelled && this.#state === "leaving") {
        const error = this.#error("invalid_state", "join", false, "Join was cancelled by Leave", cause);
        joinSpan.end({ state: this.#state, epoch: this.#epoch, outcome: "cancelled", code: error.code });
        throw error;
      }
      const error = this.#joinError(cause);
      this.#failure = failureFrom(error);
      this.#transition("failed");
      joinSpan.end({ state: this.#state, epoch: this.#epoch, outcome: "failed", code: error.code });
      throw error;
    }
  }

  #runJoinTraceStep<T>(epoch: number, parentSpanId: string, step: Exclude<ChalkSessionJoinTraceStep, "join">, operation: () => T | PromiseLike<T>): Promise<T> {
    const span = this.#diagnostics.startSpan({ step, state: this.#state, epoch, parentSpanId });
    return Promise.resolve()
      .then(operation)
      .then(
        (value) => {
          span.end({ state: this.#state, epoch: this.#epoch, outcome: "succeeded" });
          return value;
        },
        (cause: unknown) => {
          span.end({ state: this.#state, epoch: this.#epoch, outcome: cause instanceof StaleEpoch ? "cancelled" : "failed", ...(cause instanceof ChalkSessionError ? { code: cause.code } : {}) });
          throw cause;
        },
      );
  }

  async #acquireInitialMedia(): Promise<MediaStream> {
    if (!this.#localIntent.microphone && !this.#localIntent.camera) return streamFromTracks([]);
    try {
      const stream = await this.#dependencies.mediaDevices.getUserMedia({ audio: this.#localIntent.microphone, video: this.#localIntent.camera });
      for (const [source, track] of selectInitialTracks(stream, this.#localIntent)) this.#localTracks.set(source, track);
      this.#publish();
      return streamFromTracks([...this.#localTracks.values()]);
    } catch (cause) {
      throw this.#captureError(cause);
    }
  }

  async #setUserMediaEnabled(source: "microphone" | "camera", enabled: boolean): Promise<void> {
    const action = source === "microphone" ? "setMicrophoneEnabled" : "setCameraEnabled";
    return this.#serializeMediaCommand(source, action, (epoch) => this.#runCommand(action, () => this.#applyUserMediaEnabled(source, enabled, action, epoch)));
  }

  #serializeMediaCommand(source: ChalkMediaSource, action: ChalkSessionActionName, operation: (epoch: number) => Promise<void>): Promise<void> {
    const epoch = this.#epoch;
    const previous = this.#mediaCommandTails.get(source) ?? Promise.resolve();
    const execute = () => {
      this.#assertCommandEpoch(epoch, action);
      return operation(epoch);
    };
    const current = previous.then(execute, execute);
    const tail = current.catch(() => undefined);
    this.#mediaCommandTails.set(source, tail);
    void tail.then(() => {
      if (this.#mediaCommandTails.get(source) === tail) this.#mediaCommandTails.delete(source);
    });
    return current;
  }

  async #applyUserMediaEnabled(source: "microphone" | "camera", enabled: boolean, action: "setMicrophoneEnabled" | "setCameraEnabled", epoch: number): Promise<void> {
    const previousIntent = this.#localIntent[source];
    this.#localIntent[source] = enabled;
    let acquired = false;
    try {
      acquired = await this.#prepareUserMediaSource(source, enabled, action, epoch);
      await this.#setSyncMediaEnabled(source, enabled, action, epoch);
    } catch (error) {
      this.#localIntent[source] = previousIntent;
      if (acquired) await this.#discardPreparedSource(source);
      this.#publish();
      if (isPermissionDenied(error)) throw this.#error("permission_denied", action, true, `${source} permission was denied`, error);
      throw error;
    }
    this.#publish();
  }

  async #prepareUserMediaSource(source: "microphone" | "camera", enabled: boolean, action: "setMicrophoneEnabled" | "setCameraEnabled", epoch: number): Promise<boolean> {
    if (!enabled || this.#localTracks.has(source)) return false;
    const stream = await this.#dependencies.mediaDevices.getUserMedia(mediaConstraints(source));
    try {
      this.#assertCommandEpoch(epoch, action);
    } catch (error) {
      stopStream(stream);
      throw error;
    }
    const track = selectSourceTrack(stream, source);
    this.#localTracks.set(source, track);
    try {
      this.#media!.prepareLocalTrack(source, track);
      this.#publish();
      return true;
    } catch (error) {
      track.stop();
      this.#localTracks.delete(source);
      throw error;
    }
  }

  async #setSyncMediaEnabled(source: "microphone" | "camera", enabled: boolean, action: "setMicrophoneEnabled" | "setCameraEnabled", epoch: number): Promise<void> {
    if (!this.#localTracks.has(source)) return;
    const sync = this.#sync!;
    if (source === "microphone") await sync.setMicrophoneEnabled(enabled);
    else await sync.setCameraEnabled(enabled);
    this.#assertCommandEpoch(epoch, action);
  }

  async #discardPreparedSource(source: "microphone" | "camera"): Promise<void> {
    await this.#media?.clearPreparedLocalTrack(source).catch(() => undefined);
    this.#localTracks.delete(source);
  }

  async #runCommand(action: ChalkSessionActionName, operation: () => Promise<unknown>): Promise<void> {
    if (this.#state !== "live" || !this.#sync || !this.#media) throw this.#error("invalid_state", action, false, `Cannot ${action} while ${this.#state}`);
    try {
      await operation();
    } catch (cause) {
      if (cause instanceof ChalkSessionError) throw cause;
      throw this.#error("command_rejected", action, true, `${action} was not confirmed`, cause);
    }
  }

  async #runRoomAction<T>(action: ChalkSessionActionName, operation: () => Promise<T>): Promise<T> {
    if (this.#state !== "live" || !this.#sync) throw this.#error("invalid_state", action, false, `Cannot ${action} while ${this.#state}`);
    try {
      return await operation();
    } catch (cause) {
      if (cause instanceof ChalkSessionError) throw cause;
      throw this.#roomActionError(action, cause);
    }
  }

  #roomActionError(action: ChalkSessionActionName, cause: unknown): ChalkSessionError {
    const upstreamCode = errorCode(cause);
    const code: ChalkSessionErrorCode = upstreamCode === "room_actions_unavailable" ? "room_actions_unavailable" : upstreamCode === "rate_limited" ? "rate_limited" : upstreamCode === "invalid_payload" || upstreamCode === "request_id_conflict" ? "invalid_payload" : "command_rejected";
    return this.#error(code, action, code !== "invalid_payload", `${action} was not confirmed`, cause);
  }

  #subscribeLowerLayers(): void {
    this.#unsubscribeSync?.();
    this.#unsubscribeMedia?.();
    this.#unsubscribeRequests?.();
    this.#unsubscribeRoomActions?.();
    const sync = this.#sync!;
    const media = this.#media!;
    this.#unsubscribeSync = sync.subscribe((snapshot) => this.#handleSyncSnapshot(snapshot));
    this.#unsubscribeRequests = sync.onDirectedRequest((request) => this.#handleDirectedRequest(request));
    this.#unsubscribeRoomActions = sync.subscribeRoomActions((event) => this.#handleRoomActionEvent(event));
    this.#unsubscribeMedia = media.subscribe(() => this.#handleMediaSnapshot(media.getSnapshot()));
    this.#handleMediaSnapshot(media.getSnapshot());
  }

  #handleRoomActionEvent(event: V1RoomActionClientEvent): void {
    if (event.type === "reaction") {
      this.#observeReaction(event.reaction);
      return;
    }
    if (event.type === "chat_message") {
      this.#observeChatMessage(event.message, this.#state === "live");
      return;
    }
    if (event.type === "chat_read_receipt") {
      if (this.#mergeChatReadReceipt(event.receipt)) this.#publish();
      return;
    }
    this.#chat = {
      ...this.#chat,
      status: "ready",
      historyTruncated: true,
      retainedFloorSequence: event.retainedFloorSequence,
      hasOlder: false,
    };
    this.#publish();
  }

  #observeReaction(reaction: ChalkRoomReaction): void {
    if (this.#reactions.some((candidate) => candidate.eventId === reaction.eventId)) return;
    this.#reactions = [...this.#reactions, reaction].slice(-MAX_VISIBLE_REACTIONS);
    const previous = this.#reactionTimers.get(reaction.eventId);
    if (previous !== undefined) this.#dependencies.clock.clearTimeout(previous);
    const delay = Math.max(0, Date.parse(reaction.expiresAt) - this.#dependencies.clock.now());
    const timer = this.#dependencies.clock.setTimeout(() => {
      this.#reactionTimers.delete(reaction.eventId);
      this.#reactions = this.#reactions.filter((candidate) => candidate.eventId !== reaction.eventId);
      this.#publish();
    }, delay);
    this.#reactionTimers.set(reaction.eventId, timer);
    this.#publish();
  }

  #observeChatMessage(message: ChalkChatMessage, countUnread: boolean): void {
    const existing = this.#chat.messages.find((candidate) => candidate.messageId === message.messageId || candidate.sequence === message.sequence);
    const messages = existing ? this.#chat.messages : [...this.#chat.messages, message].sort((left, right) => compareSequence(left.sequence, right.sequence)).slice(-MAX_LOADED_CHAT_MESSAGES);
    const isLocal = message.participantSessionId === this.#access.current?.subject.participantSessionId;
    const alreadyRead = this.#chat.localReadThroughSequence !== null && compareSequence(message.sequence, this.#chat.localReadThroughSequence) <= 0;
    this.#chat = {
      ...this.#chat,
      status: "ready",
      messages,
      pending: this.#chat.pending.filter((pending) => pending.clientMessageId !== message.clientMessageId),
      unreadCount: countUnread && !isLocal && !existing && !alreadyRead ? this.#chat.unreadCount + 1 : this.#chat.unreadCount,
      error: null,
    };
    this.#publish();
  }

  #mergeChatReadReceipt(receipt: ChalkChatReadReceipt): boolean {
    const existing = this.#chat.readReceipts.find((candidate) => candidate.participantSessionId === receipt.participantSessionId && candidate.participantSessionGeneration === receipt.participantSessionGeneration);
    if (existing && compareSequence(existing.readThroughSequence, receipt.readThroughSequence) >= 0) return false;
    const readReceipts = this.#chat.readReceipts.filter((candidate) => candidate.participantSessionId !== receipt.participantSessionId || candidate.participantSessionGeneration !== receipt.participantSessionGeneration);
    const subject = this.#access.current?.subject;
    const local = subject?.participantSessionId === receipt.participantSessionId && subject.participantGeneration === receipt.participantSessionGeneration;
    this.#chat = {
      ...this.#chat,
      readReceipts: [...readReceipts, receipt],
      localReadThroughSequence: local ? receipt.readThroughSequence : this.#chat.localReadThroughSequence,
    };
    return true;
  }

  #applyLocalReadThrough(sequence: string): void {
    const current = this.#chat.localReadThroughSequence;
    if (current && compareSequence(current, sequence) >= 0) return;
    const localParticipantId = this.#access.current?.subject.participantSessionId;
    const unreadCount = this.#chat.messages.filter((message) => message.participantSessionId !== localParticipantId && compareSequence(message.sequence, sequence) > 0).length;
    this.#chat = { ...this.#chat, localReadThroughSequence: sequence, unreadCount };
  }

  #upsertPendingChat(clientMessageId: string, text: string, attachments: ChalkSendChatMessageInput["attachments"], state: "sending" | "failed", error: ChalkSessionFailure | null): void {
    const pending = this.#chat.pending.filter((message) => message.clientMessageId !== clientMessageId);
    this.#chat = {
      ...this.#chat,
      status: "ready",
      pending: [...pending, { clientMessageId, text, attachments: attachments ?? [], state, error }],
    };
    this.#publish();
  }

  #removePendingChat(clientMessageId: string): void {
    if (!this.#chat.pending.some((message) => message.clientMessageId === clientMessageId)) return;
    this.#chat = {
      ...this.#chat,
      pending: this.#chat.pending.filter((message) => message.clientMessageId !== clientMessageId),
    };
    this.#publish();
  }

  #handleDirectedRequest(request: V1DirectedRequest): void {
    const expiresAtMs = request.expires_at_ms;
    if (expiresAtMs <= this.#dependencies.clock.now()) return;
    const incoming: ChalkIncomingMediaRequest = {
      requestId: request.request_id,
      kind: request.name === "request_unmute" ? "unmute" : "start_camera",
      actorParticipantSessionId: request.actor_participant_session_id,
      actorDisplayName: this.#syncSnapshot?.control?.participants.find((participant) => participant.participantSessionId === request.actor_participant_session_id)?.displayName ?? null,
      expiresAt: new Date(expiresAtMs).toISOString(),
    };
    const collapsed = this.#incomingMediaRequests.filter((candidate) => candidate.requestId !== incoming.requestId && !(candidate.actorParticipantSessionId === incoming.actorParticipantSessionId && candidate.kind === incoming.kind));
    for (const candidate of this.#incomingMediaRequests) {
      if (!collapsed.includes(candidate)) this.#clearMediaRequestTimer(candidate.requestId);
    }
    this.#incomingMediaRequests = [...collapsed, incoming];
    const timer = this.#dependencies.clock.setTimeout(() => this.#removeMediaRequest(incoming.requestId), Math.max(0, expiresAtMs - this.#dependencies.clock.now()));
    this.#mediaRequestTimers.set(incoming.requestId, timer);
    this.#publish();
  }

  #removeMediaRequest(requestId: string): void {
    const next = this.#incomingMediaRequests.filter((request) => request.requestId !== requestId);
    if (next.length === this.#incomingMediaRequests.length) return;
    this.#incomingMediaRequests = next;
    this.#clearMediaRequestTimer(requestId);
    this.#publish();
  }

  #clearMediaRequestTimer(requestId: string): void {
    const timer = this.#mediaRequestTimers.get(requestId);
    if (timer !== undefined) this.#dependencies.clock.clearTimeout(timer);
    this.#mediaRequestTimers.delete(requestId);
  }

  #handleSyncSnapshot(snapshot: V1SessionSnapshot): void {
    this.#syncSnapshot = snapshot;
    const failure = syncRuntimeFailure(snapshot, this.#access.current?.subject ?? null);
    if (failure) {
      this.#failRuntime(failure.code, failure.message);
      return;
    }
    this.#removeRequestsFromMissingParticipants(snapshot);
    for (const receipt of this.#sync?.getRoomActionsExtensionState().readReceipts ?? []) this.#mergeChatReadReceipt(receipt);
    if (this.#isRuntimeActive()) this.#handleSyncConnection(snapshot.connection.phase);
    this.#scheduleChatCatchUp();
    this.#publish();
  }

  #removeRequestsFromMissingParticipants(snapshot: V1SessionSnapshot): void {
    const participantIds = new Set((snapshot.optimisticControl?.participants ?? snapshot.control?.participants ?? []).map((participant) => participant.participantSessionId));
    for (const request of this.#incomingMediaRequests) {
      if (!participantIds.has(request.actorParticipantSessionId)) this.#removeMediaRequest(request.requestId);
    }
  }

  #scheduleChatCatchUp(): void {
    const sync = this.#eligibleChatCatchUpSync();
    if (!sync) return;
    if (this.#chatCatchUpPromise) {
      this.#chatCatchUpRequested = true;
      return;
    }
    this.#startChatCatchUp(sync);
  }

  #eligibleChatCatchUpSync(): ChalkSessionSyncClient | null {
    const sync = this.#sync;
    if (!sync || sync.getSnapshot().connection.phase !== "live") return null;
    const request = chatCatchUpRequest(this.#latestChatSequence(), sync.getRoomActionsExtensionState());
    return request ? sync : null;
  }

  #startChatCatchUp(sync: ChalkSessionSyncClient): void {
    const promise = this.#catchUpChat(sync)
      .catch((cause) => {
        if (this.#sync !== sync) return;
        const failure = failureFrom(this.#roomActionError("loadOlderChatMessages", cause));
        this.#chat = { ...this.#chat, status: "failed", error: failure };
        this.#publish();
      })
      .finally(() => {
        if (this.#chatCatchUpPromise !== promise) return;
        this.#chatCatchUpPromise = null;
        if (this.#chatCatchUpRequested) {
          this.#chatCatchUpRequested = false;
          this.#scheduleChatCatchUp();
        }
      });
    this.#chatCatchUpPromise = promise;
  }

  async #catchUpChat(sync: ChalkSessionSyncClient): Promise<void> {
    while (this.#isCurrentLiveSync(sync)) {
      const request = chatCatchUpRequest(this.#latestChatSequence(), sync.getRoomActionsExtensionState());
      if (!request) return;
      const result = await sync.readChatPage(request.input);
      if (this.#sync !== sync) return;
      if ((await this.#applyChatCatchUpResult(sync, request, result)) === "stop") return;
    }
  }

  async #applyChatCatchUpResult(sync: ChalkSessionSyncClient, request: ChatCatchUpRequest, result: ChalkChatPageResult): Promise<ChatCatchUpStep> {
    if (result.status === "cursor_reset") {
      await this.#reloadChatAfterCursorReset(sync);
      return "stop";
    }
    if (request.kind === "initial") this.#setChatHasOlder(result.hasOlder);
    return result.hasOlder ? "continue" : "stop";
  }

  async #reloadChatAfterCursorReset(sync: ChalkSessionSyncClient): Promise<void> {
    const reset = await sync.readChatPage({ limit: MAX_CHAT_PAGE_SIZE });
    if (this.#sync !== sync || reset.status === "cursor_reset") return;
    this.#setChatHasOlder(reset.hasOlder);
  }

  #setChatHasOlder(hasOlder: boolean): void {
    this.#chat = { ...this.#chat, hasOlder };
    this.#publish();
  }

  #latestChatSequence(): string | null {
    return this.#chat.messages.at(-1)?.sequence ?? null;
  }

  #isCurrentLiveSync(sync: ChalkSessionSyncClient): boolean {
    return this.#sync === sync && sync.getSnapshot().connection.phase === "live";
  }

  #handleSyncConnection(phase: V1SessionSnapshot["connection"]["phase"]): void {
    if (phase === "terminal") {
      this.#requestRecovery("sync");
      return;
    }
    if (phase === "connecting" || phase === "recovering") {
      this.#transition("reconnecting");
      this.#scheduleSyncRecoveryWatchdog();
      return;
    }
    if (phase !== "live") return;
    this.#clearSyncRecoveryWatchdog();
    this.#returnToLiveIfHealthy();
  }

  #handleMediaSnapshot(snapshot: CloudflareSFUSnapshot): void {
    if (snapshot === this.#mediaSnapshot) return;
    this.#mediaSnapshot = snapshot;
    this.#handleMediaConnection(snapshot);
    this.#publish();
  }

  #handleMediaConnection(snapshot: CloudflareSFUSnapshot): void {
    if (this.#isRuntimeActive() && snapshot.connection.phase === "failed" && snapshot.failure?.recoverable) this.#requestRecovery("media");
    else if (this.#isRuntimeActive() && snapshot.connection.phase === "recovering") this.#transition("reconnecting");
    else if (snapshot.connection.phase === "live") this.#returnToLiveIfHealthy();
  }

  #handleMediaFailure(): void {
    const snapshot = this.#media?.getSnapshot();
    if (snapshot) this.#handleMediaSnapshot(snapshot);
  }

  #requestRecovery(kind: RecoveryKind): void {
    if (this.#state !== "live" && this.#state !== "reconnecting") return;
    this.#pendingRecovery = this.#pendingRecovery === "media" ? "media" : kind;
    this.#transition("reconnecting");
    if (this.#recoveryPromise) return;
    const promise = this.#runRecoveryLoop().finally(() => {
      if (this.#recoveryPromise === promise) this.#recoveryPromise = null;
    });
    this.#recoveryPromise = promise;
    void promise.catch(() => undefined);
  }

  async #runRecoveryLoop(): Promise<void> {
    while (this.#pendingRecovery && this.#isRuntimeActive()) {
      const kind = this.#pendingRecovery;
      this.#pendingRecovery = null;
      const outcome = await this.#recoverWithinBudget(kind);
      if (outcome === "stale") return;
      if (outcome === "exhausted") {
        await this.#exhaustRecovery(kind);
        return;
      }
    }
  }

  async #recoverWithinBudget(kind: RecoveryKind): Promise<"recovered" | "stale" | "exhausted"> {
    const deadline = this.#dependencies.clock.now() + this.#recoveryBudgetMs;
    for (let attempt = 1; this.#recoveryAttemptAllowed(attempt, deadline); attempt++) {
      const outcome = await this.#attemptRecovery(kind, attempt, deadline);
      if (outcome !== "failed") return outcome;
      await this.#waitBeforeRecoveryRetry(attempt, deadline);
    }
    return "exhausted";
  }

  async #attemptRecovery(kind: RecoveryKind, attempt: number, deadline: number): Promise<"recovered" | "stale" | "failed"> {
    const epoch = ++this.#epoch;
    this.#diagnostics.record({ event: "recovery_attempt", state: this.#state, epoch, attempt });
    try {
      const recovery = kind === "media" ? this.#recoverMedia(epoch) : this.#recoverSync(epoch);
      await this.#withTimeout(recovery, Math.max(0, deadline - this.#dependencies.clock.now()));
      this.#assertEpoch(epoch);
      this.#diagnostics.record({ event: "recovery_succeeded", state: this.#state, epoch, attempt });
      this.#returnToLiveIfHealthy();
      return "recovered";
    } catch (error) {
      if (error instanceof StaleEpoch) return "stale";
      if (this.#epoch === epoch) this.#epoch++;
      return "failed";
    }
  }

  #recoveryAttemptAllowed(attempt: number, deadline: number): boolean {
    return attempt <= this.#maxRecoveryAttempts && this.#dependencies.clock.now() < deadline;
  }

  async #waitBeforeRecoveryRetry(attempt: number, deadline: number): Promise<void> {
    if (attempt >= this.#maxRecoveryAttempts) return;
    const delay = Math.max(0, this.#recoveryBackoffMs[Math.min(attempt - 1, this.#recoveryBackoffMs.length - 1)] ?? 0);
    if (this.#dependencies.clock.now() + delay < deadline) await this.#sleep(delay);
  }

  async #exhaustRecovery(kind: RecoveryKind): Promise<void> {
    const code = kind === "media" ? "media_recovery_exhausted" : "sync_recovery_exhausted";
    this.#failure = this.#failureValue(code, null, false, `${kind} recovery exhausted its retry budget`);
    this.#diagnostics.record({ event: "recovery_exhausted", state: this.#state, epoch: this.#epoch, code });
    this.#failedCleanupRequired = true;
    this.#transition("failed");
    await this.#teardown(false);
  }

  async #recoverMedia(epoch: number): Promise<void> {
    const access = await this.#access.refresh("media_recovery", true);
    this.#assertEpoch(epoch);
    await this.#media!.restart(access.media.clientPayload);
    this.#assertEpoch(epoch);
    this.#mediaSnapshot = this.#media!.getSnapshot();
    await this.#waitForSyncLive(this.#sync!, this.#recoveryBudgetMs);
  }

  async #recoverSync(epoch: number): Promise<void> {
    await this.#access.getSyncToken("sync_recovery");
    this.#assertEpoch(epoch);
    this.#unsubscribeSync?.();
    this.#unsubscribeRequests?.();
    this.#unsubscribeRoomActions?.();
    this.#sync?.stop();
    const access = this.#access.current!;
    const sync = this.#dependencies.createSyncClient({ access, token: () => this.#access.getSyncToken(), media: this.#media! });
    this.#sync = sync;
    this.#unsubscribeSync = sync.subscribe((snapshot) => this.#handleSyncSnapshot(snapshot));
    this.#unsubscribeRequests = sync.onDirectedRequest((request) => this.#handleDirectedRequest(request));
    this.#unsubscribeRoomActions = sync.subscribeRoomActions((event) => this.#handleRoomActionEvent(event));
    await sync.start();
    await this.#waitForSyncLive(sync, this.#recoveryBudgetMs);
    this.#assertEpoch(epoch);
  }

  #scheduleAccessRefresh(delay = this.#access.millisecondsUntilRefresh()): void {
    this.#clearRefreshTimer();
    if (delay === null || this.#state !== "live") return;
    this.#refreshTimer = this.#dependencies.clock.setTimeout(() => {
      this.#refreshTimer = undefined;
      void this.#access
        .refresh("scheduled_refresh", false)
        .then(() => {
          this.#diagnostics.record({ event: "access_refreshed", state: this.#state, epoch: this.#epoch });
          this.#scheduleAccessRefresh();
        })
        .catch(() => {
          this.#diagnostics.record({ event: "access_refresh_failed", state: this.#state, epoch: this.#epoch, code: "access_unavailable" });
          this.#scheduleAccessRefresh(REFRESH_RETRY_MS);
        });
    }, delay);
  }

  #scheduleSyncRecoveryWatchdog(): void {
    if (this.#syncRecoveryTimer !== undefined) return;
    this.#syncRecoveryTimer = this.#dependencies.clock.setTimeout(() => {
      this.#syncRecoveryTimer = undefined;
      if (this.#state === "reconnecting" && this.#syncSnapshot?.connection.phase !== "live") this.#requestRecovery("sync");
    }, this.#recoveryBudgetMs);
  }

  async #teardown(durableLeave: boolean): Promise<boolean> {
    if (this.#teardownPromise) return this.#teardownPromise;
    const promise = this.#performTeardown(durableLeave).finally(() => {
      if (this.#teardownPromise === promise) this.#teardownPromise = null;
    });
    this.#teardownPromise = promise;
    return promise;
  }

  async #performTeardown(durableLeave: boolean): Promise<boolean> {
    this.#cancelRuntimeWork();
    const confirmed = await this.#confirmDurableLeave(durableLeave);
    this.#stopLowerLayers();
    this.#failedCleanupRequired = false;
    this.#diagnostics.record({ event: "cleanup_completed", state: this.#state, epoch: this.#epoch });
    this.#publish();
    return confirmed;
  }

  #cancelRuntimeWork(): void {
    this.#clearRefreshTimer();
    this.#clearSyncRecoveryWatchdog();
    this.#clearSleeps();
    this.#pendingRecovery = null;
    this.#screenEndedPending = false;
    this.#unsubscribeSync?.();
    this.#unsubscribeSync = null;
    this.#unsubscribeRequests?.();
    this.#unsubscribeRequests = null;
    this.#unsubscribeRoomActions?.();
    this.#unsubscribeRoomActions = null;
    this.whiteboard?.stopSceneSubscription();
    this.#whiteboardSummary = emptyWhiteboardSummary();
    this.#clearRoomActionTimers();
    this.#reactions = [];
    this.#incomingMediaRequests = [];
    this.#unsubscribeMedia?.();
    this.#unsubscribeMedia = null;
  }

  async #confirmDurableLeave(durableLeave: boolean): Promise<boolean> {
    if (this.#sessionEndConfirmed) return true;
    if (!durableLeave || this.#access.current === null) return true;
    if (!this.#sync) return false;
    try {
      await this.#withTimeout(this.#sync.leave(), LEAVE_TIMEOUT_MS);
      return true;
    } catch {
      return false;
    }
  }

  #stopLowerLayers(): void {
    this.#sync?.stop();
    this.#media?.stop();
    this.#syncSnapshot = this.#sync?.getSnapshot() ?? null;
    this.#mediaSnapshot = this.#media?.getSnapshot() ?? null;
    for (const track of this.#localTracks.values()) track.stop();
    this.#localTracks.clear();
    this.#sync = null;
    this.#media = null;
    this.#access.clear();
  }

  #waitForSyncLive(sync: ChalkSessionSyncClient, timeoutMs: number): Promise<void> {
    if (sync.getSnapshot().connection.phase === "live") return Promise.resolve();
    return new Promise((resolve, reject) => {
      let settled = false;
      let unsubscribe: (() => void) | undefined;
      const timer = this.#dependencies.clock.setTimeout(() => finish(() => reject(new SyncStartupDeadline(sync.getSnapshot()))), timeoutMs);
      const finish = (complete: () => void) => {
        if (settled) return;
        settled = true;
        this.#dependencies.clock.clearTimeout(timer);
        unsubscribe?.();
        complete();
      };
      unsubscribe = sync.subscribe((snapshot) => {
        if (snapshot.connection.phase === "live") finish(resolve);
        else if (snapshot.connection.phase === "terminal" || snapshot.connection.phase === "stopped") finish(() => reject(new TypeError("Sync stopped before becoming live")));
      });
      if (settled) unsubscribe();
    });
  }

  #withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = this.#dependencies.clock.setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new TypeError("Operation timed out"));
      }, timeoutMs);
      promise.then(
        (value) => {
          if (settled) return;
          settled = true;
          this.#dependencies.clock.clearTimeout(timer);
          resolve(value);
        },
        (error) => {
          if (settled) return;
          settled = true;
          this.#dependencies.clock.clearTimeout(timer);
          reject(error);
        },
      );
    });
  }

  #sleep(milliseconds: number): Promise<void> {
    if (milliseconds === 0) return Promise.resolve();
    return new Promise((resolve) => {
      const pending = {
        handle: undefined as unknown,
        resolve: () => {
          this.#sleeps.delete(pending);
          resolve();
        },
      };
      pending.handle = this.#dependencies.clock.setTimeout(pending.resolve, milliseconds);
      this.#sleeps.add(pending);
    });
  }

  #returnToLiveIfHealthy(): void {
    if (this.#state !== "reconnecting") return;
    if (this.#syncSnapshot?.connection.phase !== "live" || this.#mediaSnapshot?.connection.phase !== "live") return;
    this.#transition("live");
    this.#scheduleAccessRefresh();
    if (this.#screenEndedPending) {
      this.#screenEndedPending = false;
      void this.stopScreenShare().catch(() => undefined);
    }
  }

  #isRuntimeActive(): boolean {
    return this.#state === "live" || this.#state === "reconnecting";
  }

  #isFullyTornDown(): boolean {
    return !this.#teardownPromise && !this.#sync && !this.#media && this.#localTracks.size === 0 && this.#mediaCommandTails.size === 0 && this.#access.current === null;
  }

  #handleScreenEnded(): void {
    if (!this.#localTracks.has("screen")) return;
    if (this.#state === "reconnecting") {
      this.#screenEndedPending = true;
      return;
    }
    void this.stopScreenShare().catch(() => undefined);
  }

  #failRuntime(code: "invalid_access" | "session_ended", message: string): void {
    if (this.#state === "leaving" || this.#state === "left") return;
    ++this.#epoch;
    this.#failure = this.#failureValue(code, null, false, message);
    this.#failedCleanupRequired = true;
    this.#transition("failed");
    void this.#teardown(false);
  }

  #transition(state: ChalkSessionState): void {
    if (this.#state === state) return;
    this.#state = state;
    this.#diagnostics.record({ event: "state_changed", state, epoch: this.#epoch });
    this.#publish();
  }

  #publish(): void {
    this.#snapshot = projectChalkSessionSnapshot({
      state: this.#state,
      subject: this.#access.current?.subject ?? null,
      sync: this.#syncSnapshot,
      media: this.#mediaSnapshot,
      localTracks: this.#localTracks,
      localIntent: this.#localIntent,
      failure: this.#failure,
      roomActions: this.#roomActionsSnapshot(),
      participantRoomActionCapabilities: this.#sync?.getParticipantRoomActionCapabilities() ?? {},
      reactions: this.#reactions,
      chat: this.#chat,
      whiteboard: this.#whiteboardSummary,
      incomingMediaRequests: this.#incomingMediaRequests,
    });
    for (const listener of this.#listeners) {
      try {
        listener();
      } catch {
        // Consumer listeners cannot interfere with session ownership.
      }
    }
  }

  #resetForJoin(): void {
    this.#failure = null;
    this.#syncSnapshot = null;
    this.#mediaSnapshot = null;
    this.#pendingRecovery = null;
    this.#joinCleanupConfirmed = null;
    this.#screenEndedPending = false;
    this.#sessionEndConfirmed = false;
    this.#failedCleanupRequired = false;
    this.#clearRoomActionTimers();
    this.#reactions = [];
    this.#chat = emptyChatState();
    this.#whiteboardSummary = emptyWhiteboardSummary();
    this.#incomingMediaRequests = [];
  }

  #roomActionsSnapshot(): ChalkSessionSnapshot["roomActions"] {
    const extension = this.#sync?.getRoomActionsExtensionState();
    if (!extension) {
      return {
        phase: this.#state === "idle" || this.#state === "left" ? "disabled" : "stopped",
        version: null,
        capabilities: [],
        error: null,
      };
    }
    const syncPhase = this.#syncSnapshot?.connection.phase;
    const phase = syncPhase === "connecting" ? "negotiating" : syncPhase === "recovering" ? "recovering" : syncPhase === "stopped" ? "stopped" : extension.negotiated && syncPhase === "live" ? "healthy" : "disabled";
    return { phase, version: extension.version, capabilities: extension.capabilities, error: null };
  }

  #clearRoomActionTimers(): void {
    for (const timer of this.#reactionTimers.values()) this.#dependencies.clock.clearTimeout(timer);
    this.#reactionTimers.clear();
    for (const timer of this.#mediaRequestTimers.values()) this.#dependencies.clock.clearTimeout(timer);
    this.#mediaRequestTimers.clear();
  }

  #assertEpoch(epoch: number): void {
    if (epoch !== this.#epoch) throw new StaleEpoch();
  }

  #assertCommandEpoch(epoch: number, action: ChalkSessionActionName): void {
    if (epoch !== this.#epoch) throw this.#error("invalid_state", action, false, `${action} belongs to an inactive session`);
  }

  #clearRefreshTimer(): void {
    if (this.#refreshTimer !== undefined) this.#dependencies.clock.clearTimeout(this.#refreshTimer);
    this.#refreshTimer = undefined;
  }

  #clearSyncRecoveryWatchdog(): void {
    if (this.#syncRecoveryTimer !== undefined) this.#dependencies.clock.clearTimeout(this.#syncRecoveryTimer);
    this.#syncRecoveryTimer = undefined;
  }

  #clearSleeps(): void {
    for (const pending of this.#sleeps) {
      this.#dependencies.clock.clearTimeout(pending.handle);
      pending.resolve();
    }
    this.#sleeps.clear();
  }

  #joinError(cause: unknown): ChalkSessionError {
    if (cause instanceof ChalkSessionError) return cause;
    if (cause instanceof StartupFailure) {
      const { code, message } = startupFailureDetails(cause);
      return this.#error(code, "join", true, message, cause.cause);
    }
    if (cause instanceof ParticipantAccessError || (cause instanceof TypeError && this.#access.current === null)) return this.#error("invalid_access", "join", false, "Participant access was rejected", cause);
    const code = this.#access.current === null ? "access_unavailable" : this.#syncSnapshot?.connection.phase !== "live" ? "sync_start_failed" : "media_start_failed";
    return this.#error(code, "join", code === "access_unavailable", "The session could not join", cause);
  }

  #captureError(cause: unknown): ChalkSessionError {
    if (isPermissionDenied(cause)) return this.#error("permission_denied", "join", true, "Camera or microphone permission was denied", cause);
    return this.#error("unsupported_environment", "join", false, "Browser media capture is unavailable", cause);
  }

  #error(code: ChalkSessionErrorCode, action: ChalkSessionActionName | null, recoverable: boolean, message: string, cause?: unknown): ChalkSessionError {
    return new ChalkSessionError(this.#failureValue(code, action, recoverable, message), cause === undefined ? undefined : { cause });
  }

  #failureValue(code: ChalkSessionErrorCode, action: ChalkSessionActionName | null, recoverable: boolean, message: string): ChalkSessionFailure {
    return Object.freeze({ code, action, recoverable, message });
  }
}

class StaleEpoch extends Error {}

class StartupFailure extends Error {
  constructor(
    readonly layer: "sync" | "media",
    override readonly cause: unknown,
  ) {
    super(`${layer} startup failed`);
  }
}

class SyncStartupDeadline extends TypeError {
  constructor(readonly snapshot: V1SessionSnapshot) {
    super("Sync did not become live before the startup deadline");
  }
}

function syncStartupDeadlineMessage(snapshot: V1SessionSnapshot): string {
  if (snapshot.connection.phase === "connecting") return "The Sync transport could not establish a connection";
  if (snapshot.connection.phase !== "recovering") return "The Sync layer did not become live";
  if (snapshot.participantSessionId === null) return "The Sync transport connected but did not receive its welcome frame";
  const missing = [snapshot.control === null ? "control state" : null, snapshot.media === null ? "media projection" : null, snapshot.presence === null ? "presence projection" : null].filter((value): value is string => value !== null);
  return missing.length === 0 ? "The Sync layer did not finish recovery" : `The Sync layer did not receive its ${missing.join(", ")}`;
}

function startupFailureDetails(failure: StartupFailure): { readonly code: "sync_start_failed" | "media_start_failed"; readonly message: string } {
  if (failure.layer === "media") return { code: "media_start_failed", message: "The media layer could not start" };
  if (failure.cause instanceof SyncStartupDeadline) return { code: "sync_start_failed", message: syncStartupDeadlineMessage(failure.cause.snapshot) };
  return { code: "sync_start_failed", message: "The sync layer could not start" };
}

function failureFrom(error: ChalkSessionError): ChalkSessionFailure {
  return Object.freeze({ code: error.code, action: error.action, recoverable: error.recoverable, message: error.message });
}

function selectInitialTracks(stream: MediaStream, intent: Readonly<Record<"microphone" | "camera", boolean>>): Map<"microphone" | "camera", MediaStreamTrack> {
  const tracks = stream.getTracks();
  const microphone = requestedTrack(tracks, "audio", intent.microphone);
  const camera = requestedTrack(tracks, "video", intent.camera);
  const selected = new Set([microphone, camera].filter((track): track is MediaStreamTrack => track !== undefined));
  stopUnselectedTracks(tracks, selected);
  requireRequestedTracks(intent, microphone, camera, selected);
  return selectedTrackMap(microphone, camera);
}

function requestedTrack(tracks: readonly MediaStreamTrack[], kind: "audio" | "video", required: boolean): MediaStreamTrack | undefined {
  return required ? tracks.find((track) => track.kind === kind) : undefined;
}

function stopUnselectedTracks(tracks: readonly MediaStreamTrack[], selected: ReadonlySet<MediaStreamTrack>): void {
  for (const track of tracks) {
    if (!selected.has(track)) track.stop();
  }
}

function requireRequestedTracks(intent: Readonly<Record<"microphone" | "camera", boolean>>, microphone: MediaStreamTrack | undefined, camera: MediaStreamTrack | undefined, selected: ReadonlySet<MediaStreamTrack>): void {
  const missing = (intent.microphone && !microphone) || (intent.camera && !camera);
  if (!missing) return;
  for (const track of selected) track.stop();
  throw new TypeError("Media capture did not return every requested track");
}

function selectedTrackMap(microphone: MediaStreamTrack | undefined, camera: MediaStreamTrack | undefined): Map<"microphone" | "camera", MediaStreamTrack> {
  const entries: ["microphone" | "camera", MediaStreamTrack][] = [];
  if (microphone) entries.push(["microphone", microphone]);
  if (camera) entries.push(["camera", camera]);
  return new Map(entries);
}

function mediaConstraints(source: "microphone" | "camera"): MediaStreamConstraints {
  return { audio: source === "microphone", video: source === "camera" };
}

function selectSourceTrack(stream: MediaStream, source: "microphone" | "camera"): MediaStreamTrack {
  const kind = source === "microphone" ? "audio" : "video";
  const selected = stream.getTracks().find((track) => track.kind === kind);
  if (!selected) {
    stopStream(stream);
    throw new TypeError(`Media capture did not return a ${source} track`);
  }
  for (const track of stream.getTracks()) {
    if (track !== selected) track.stop();
  }
  return selected;
}

function syncSubjectMismatch(snapshot: V1SessionSnapshot, subject: ParticipantAccessSubject | null): boolean {
  if (!subject || snapshot.participantSessionId === null) return false;
  return snapshot.participantSessionId !== subject.participantSessionId || snapshot.participantSessionGeneration !== subject.participantGeneration;
}

function syncSessionEnded(snapshot: V1SessionSnapshot): boolean {
  return snapshot.control?.status === "ended" || snapshot.optimisticControl?.status === "ended";
}

function syncRuntimeFailure(snapshot: V1SessionSnapshot, subject: ParticipantAccessSubject | null): SyncRuntimeFailure | null {
  if (syncSubjectMismatch(snapshot, subject)) {
    return { code: "invalid_access", message: "Sync authenticated a different participant subject" };
  }
  if (syncSessionEnded(snapshot)) {
    return { code: "session_ended", message: "The session has ended" };
  }
  return null;
}

function chatCatchUpRequest(latestSequence: string | null, extension: V1RoomActionsExtensionState): ChatCatchUpRequest | null {
  const head = extension.chatHeadSequence;
  if (!extension.negotiated || head === null || (latestSequence !== null && compareSequence(latestSequence, head) >= 0)) return null;
  if (latestSequence === null) return { kind: "initial", input: { limit: MAX_CHAT_PAGE_SIZE } };
  return { kind: "newer", input: { afterSequence: latestSequence, limit: MAX_CHAT_PAGE_SIZE } };
}

function validateChatMessageInput(input: ChalkSendChatMessageInput): string | null {
  const attachments = input.attachments ?? [];
  if (input.text.length === 0 && attachments.length === 0) return "A chat message requires text or an attachment";
  return validateChatText(input.text) ?? validateChatAttachments(attachments);
}

function validateChatText(text: string): string | null {
  if (Array.from(text).length <= MAX_CHAT_TEXT_SCALARS && chatEncoder.encode(text).byteLength <= MAX_CHAT_TEXT_BYTES) return null;
  return `Chat text must not exceed ${MAX_CHAT_TEXT_SCALARS} characters or ${MAX_CHAT_TEXT_BYTES} bytes`;
}

function validateChatAttachments(attachments: NonNullable<ChalkSendChatMessageInput["attachments"]>): string | null {
  if (attachments.length > CHALK_CHAT_ATTACHMENT_LIMITS.maximumPerMessage) return `A chat message supports at most ${CHALK_CHAT_ATTACHMENT_LIMITS.maximumPerMessage} attachments`;
  if (new Set(attachments.map((attachment) => attachment.attachmentId)).size !== attachments.length) return "Chat attachment IDs must be unique";
  for (const attachment of attachments) {
    const failure = validateChatAttachment(attachment);
    if (failure) return failure;
  }
  return null;
}

function validateChatAttachment(attachment: NonNullable<ChalkSendChatMessageInput["attachments"]>[number]): string | null {
  const fileNameBytes = chatEncoder.encode(attachment.fileName).byteLength;
  if (!attachment.attachmentId || fileNameBytes < 1 || fileNameBytes > CHALK_CHAT_ATTACHMENT_LIMITS.maximumFileNameBytes) return "Chat attachment metadata is invalid";
  if (!Number.isSafeInteger(attachment.byteLength) || attachment.byteLength < 1 || attachment.byteLength > CHALK_CHAT_ATTACHMENT_LIMITS.maximumByteLength) return "Chat attachment metadata is invalid";
  return allowedChatAttachmentMimeTypes.has(attachment.mimeType) ? null : "Chat attachment MIME type is not allowed";
}

function isPermissionDenied(error: unknown): boolean {
  return error instanceof DOMException && (error.name === "NotAllowedError" || error.name === "SecurityError");
}

function boundedInteger(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new TypeError(`Expected an integer between ${minimum} and ${maximum}`);
  return value;
}

function emptyChatState(): ChalkChatState {
  return {
    status: "idle",
    messages: [],
    pending: [],
    hasOlder: false,
    historyTruncated: false,
    retainedFloorSequence: null,
    unreadCount: 0,
    readReceipts: [],
    localReadThroughSequence: null,
    error: null,
  };
}

function emptyWhiteboardSummary(): ChalkWhiteboardSummary {
  return {
    status: "unsubscribed",
    sceneId: null,
    revision: null,
    capabilities: [],
    canDraw: false,
    canClear: false,
    error: null,
  };
}

function roomActionId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `chat-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function directedRequestResult(result: Awaited<ReturnType<ChalkSessionSyncClient["requestUnmute"]>>): ChalkDirectedRequestResult {
  return { status: result.result, requestId: result.request_id };
}

function compareSequence(left: string, right: string): number {
  if (left.length !== right.length) return left.length - right.length;
  return left.localeCompare(right);
}

function errorCode(cause: unknown): string | null {
  if (typeof cause !== "object" || cause === null || !("code" in cause)) return null;
  return typeof cause.code === "string" ? cause.code : null;
}
