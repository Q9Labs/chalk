import type { SyncV1ClientFrame, SyncV1ServerFrame } from "../generated/sync";
import type { ChalkChatMessage, ChalkChatPageResult, ChalkChatReadReceipt, ChalkReaction, ChalkReactionEvent, ChalkSendChatMessageInput, ChalkSyncV1CollaborationCapability } from "../collaboration/types";
import { chatMessageFromFrame, chatReadReceiptFromFrame, reactionFromFrame } from "../collaboration/wire";
import { encodeV1ClientFrame } from "./v1-codec";
import { rejectV1Deferred, resolveV1Deferred, type V1Deferred } from "./v1-deferred";
import { V1SyncError } from "./v1-error";
import { V1ReplicaError } from "./v1-reducer";
import type { V1CollaborationEvent, V1CollaborationExtensionState, V1SyncClientOptions } from "./v1-types";

const MAX_COLLABORATION_REQUESTS_IN_FLIGHT = 64;

type ReactionDeferred = V1Deferred<ChalkReactionEvent>;
type ChatSendDeferred = V1Deferred<ChalkChatMessage>;
type ChatPageDeferred = V1Deferred<ChalkChatPageResult>;
type ChatReadDeferred = V1Deferred<ChalkChatReadReceipt>;

export type V1CollaborationHelloExtension = {
  readonly name: "collaboration_v1";
  readonly chat_cursor: {
    readonly after_sequence: string | null;
    readonly retained_floor_sequence: string | null;
  };
};

type V1CollaborationStateOptions = {
  readonly request: V1SyncClientOptions["collaboration"];
  readonly requestIds: V1SyncClientOptions["requestIds"];
  readonly maxPendingRequests: number | undefined;
  readonly isLive: () => boolean;
  readonly send: (frame: SyncV1ClientFrame) => void;
  readonly stateChanged: () => void;
};

export class V1CollaborationState {
  readonly #options: V1CollaborationStateOptions;
  readonly #listeners = new Set<(event: V1CollaborationEvent) => void>();
  readonly #reactions = new Map<string, ReactionDeferred>();
  readonly #chatSends = new Map<string, ChatSendDeferred>();
  readonly #chatPages = new Map<string, ChatPageDeferred>();
  readonly #chatReads = new Map<string, ChatReadDeferred>();
  #state: V1CollaborationExtensionState;
  #participantCapabilities: Readonly<Record<string, readonly ChalkSyncV1CollaborationCapability[]>> = {};
  #chatAfterSequence: string | null;
  #requestedVersion: 0 | 1;

  constructor(options: V1CollaborationStateOptions) {
    this.#options = options;
    const cursor = options.request === false ? { afterSequence: null, retainedFloorSequence: null } : (options.request?.chatCursor ?? { afterSequence: null, retainedFloorSequence: null });
    this.#chatAfterSequence = cursor.afterSequence;
    this.#requestedVersion = options.request === false ? 0 : 1;
    this.#state = {
      negotiated: false,
      version: null,
      capabilities: [],
      chatHeadSequence: null,
      retainedFloorSequence: cursor.retainedFloorSequence,
      readReceipts: [],
    };
  }

  get requestedVersion(): 0 | 1 {
    return this.#requestedVersion;
  }

  get helloExtension(): V1CollaborationHelloExtension | null {
    if (this.#requestedVersion === 0) return null;
    return { name: "collaboration_v1", chat_cursor: { after_sequence: this.#chatAfterSequence, retained_floor_sequence: this.#state.retainedFloorSequence } };
  }

  getState(): V1CollaborationExtensionState {
    return { ...this.#state, capabilities: [...this.#state.capabilities], readReceipts: this.#state.readReceipts.map((receipt) => ({ ...receipt })) };
  }

  getParticipantCapabilities(): Readonly<Record<string, readonly ChalkSyncV1CollaborationCapability[]>> {
    return Object.fromEntries(Object.entries(this.#participantCapabilities).map(([participantId, capabilities]) => [participantId, [...capabilities]]));
  }

  subscribe(listener: (event: V1CollaborationEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  acceptWelcome(frame: Extract<SyncV1ServerFrame, { readonly type: "welcome" }>): void {
    if ("extensions" in frame) {
      const extension = frame.extensions[0];
      const version = 1;
      if (this.#requestedVersion !== version) throw new V1ReplicaError("collaboration welcome version does not match the requested extension");
      this.#state = {
        negotiated: true,
        version,
        capabilities: [...extension.capabilities],
        chatHeadSequence: extension.chat_head_sequence,
        retainedFloorSequence: extension.retained_floor_sequence,
        readReceipts: "read_receipts" in extension ? extension.read_receipts.map(chatReadReceiptFromWire) : [],
      };
      this.#participantCapabilities = copyCapabilities(extension.participant_capabilities);
      return;
    }
    this.#requestedVersion = 0;
    this.#state = { ...this.#state, negotiated: false, version: null, capabilities: [], readReceipts: [] };
    this.#participantCapabilities = {};
  }

  disconnect(code: string): void {
    this.#rejectPending(code);
    this.#state = { ...this.#state, negotiated: false, version: null, capabilities: [], readReceipts: [] };
    this.#participantCapabilities = {};
  }

  sendReaction(reaction: ChalkReaction): Promise<ChalkReactionEvent> {
    this.#assertReady("sendReaction");
    this.#assertCapacity();
    const operationId = this.#nextRequestId();
    const frame = { type: "reaction_send", operation_id: operationId, reaction } as const;
    return this.#sendTrackedRequest(operationId, frame, this.#reactions);
  }

  sendChatMessage(input: ChalkSendChatMessageInput): Promise<ChalkChatMessage> {
    this.#assertReady("sendChat");
    this.#assertCapacity();
    const clientMessageId = input.clientMessageId ?? this.#nextRequestId();
    this.#assertRequestIdAvailable(clientMessageId);
    const attachments = input.attachments ?? [];
    const frame = { type: "chat_send", client_message_id: clientMessageId, text: input.text, attachment_ids: attachments.map((attachment) => attachment.attachmentId) } as const;
    return this.#sendTrackedRequest(clientMessageId, frame, this.#chatSends);
  }

  markChatRead(sequence: string): Promise<ChalkChatReadReceipt> {
    this.#assertReady();
    if (this.#state.version !== 1) throw new V1SyncError("durable chat read receipts require collaboration_v1", "collaboration_unavailable");
    this.#assertCapacity();
    const requestId = this.#nextRequestId();
    const frame = { type: "chat_read_set", request_id: requestId, sequence } as const;
    return this.#sendTrackedRequest(requestId, frame, this.#chatReads);
  }

  readChatPage(input: { readonly beforeSequence?: string; readonly afterSequence?: string; readonly limit: number }): Promise<ChalkChatPageResult> {
    this.#assertReady();
    this.#assertCapacity();
    if (input.beforeSequence !== undefined && input.afterSequence !== undefined) throw new V1SyncError("a chat page cannot declare both cursors", "invalid_payload");
    const requestId = this.#nextRequestId();
    const frame = {
      type: "chat_page_request",
      request_id: requestId,
      direction: input.afterSequence === undefined ? ("older" as const) : ("newer" as const),
      cursor_sequence: input.afterSequence ?? input.beforeSequence ?? null,
      limit: input.limit,
    } as const;
    return this.#sendTrackedRequest(requestId, frame, this.#chatPages);
  }

  reaction(frame: Extract<SyncV1ServerFrame, { readonly type: "reaction" }>): void {
    this.#requireLive();
    this.#requireNegotiated();
    this.#emit({ type: "reaction", reaction: reactionFromFrame(frame) });
  }

  reactionResult(frame: Extract<SyncV1ServerFrame, { readonly type: "reaction_result" }>): void {
    this.#requireLive();
    this.#requireNegotiated();
    const deferred = this.#reactions.get(frame.operation_id);
    if (!deferred) return;
    this.#reactions.delete(frame.operation_id);
    if (frame.outcome === "accepted") resolveV1Deferred(deferred, reactionFromFrame(frame.reaction));
    else rejectV1Deferred(deferred, new V1SyncError(frame.error_code, frame.error_code));
  }

  chatMessage(frame: Extract<SyncV1ServerFrame, { readonly type: "chat_message" }>): void {
    this.#requireNegotiated();
    this.#observeChatMessage(frame);
  }

  chatSendResult(frame: Extract<SyncV1ServerFrame, { readonly type: "chat_send_result" }>): void {
    this.#requireLive();
    this.#requireNegotiated();
    const deferred = this.#chatSends.get(frame.client_message_id);
    if (!deferred) return;
    this.#chatSends.delete(frame.client_message_id);
    if (frame.outcome === "accepted") {
      this.#assertChatMessageVersion(frame.message);
      const message = chatMessageFromFrame(frame.message);
      this.#rememberChatSequence(message.sequence);
      resolveV1Deferred(deferred, message);
    } else {
      rejectV1Deferred(deferred, new V1SyncError(frame.error_code, frame.error_code));
    }
  }

  chatPage(frame: Extract<SyncV1ServerFrame, { readonly type: "chat_page" }>): void {
    this.#requireNegotiated();
    const deferred = this.#chatPages.get(frame.request_id);
    if (!deferred) return;
    this.#chatPages.delete(frame.request_id);
    if (frame.outcome === "cursor_reset") {
      this.#state = { ...this.#state, retainedFloorSequence: frame.retained_floor_sequence };
      const result = { status: "cursor_reset", retainedFloorSequence: frame.retained_floor_sequence } as const;
      this.#emit({ type: "chat_cursor_reset", retainedFloorSequence: frame.retained_floor_sequence });
      resolveV1Deferred(deferred, result);
      return;
    }
    this.#state = { ...this.#state, chatHeadSequence: frame.head_sequence, retainedFloorSequence: frame.retained_floor_sequence };
    for (const message of frame.messages) this.#observeChatMessage(message);
    resolveV1Deferred(deferred, { status: "loaded", count: frame.messages.length, hasOlder: frame.has_more });
  }

  chatHead(frame: Extract<SyncV1ServerFrame, { readonly type: "chat_head" }>): void {
    this.#requireNegotiated();
    this.#state = { ...this.#state, chatHeadSequence: frame.head_sequence, retainedFloorSequence: frame.retained_floor_sequence };
    this.#options.stateChanged();
  }

  chatReadReceipt(frame: Extract<SyncV1ServerFrame, { readonly type: "chat_read_receipt" }>): void {
    this.#requireLive();
    this.#requireVersion(1);
    const receipt = chatReadReceiptFromFrame(frame);
    this.#rememberChatReadReceipt(receipt);
    this.#emit({ type: "chat_read_receipt", receipt });
  }

  chatReadResult(frame: Extract<SyncV1ServerFrame, { readonly type: "chat_read_result" }>): void {
    this.#requireLive();
    this.#requireVersion(1);
    const deferred = this.#chatReads.get(frame.request_id);
    if (!deferred) return;
    this.#chatReads.delete(frame.request_id);
    if (frame.outcome === "accepted") {
      const receipt = chatReadReceiptFromFrame(frame);
      this.#rememberChatReadReceipt(receipt);
      resolveV1Deferred(deferred, receipt);
    } else {
      rejectV1Deferred(deferred, new V1SyncError(frame.error_code, frame.error_code));
    }
  }

  #rejectPending(code: string): void {
    for (const deferred of this.#reactions.values()) rejectV1Deferred(deferred, new V1SyncError(code, code));
    for (const deferred of this.#chatSends.values()) rejectV1Deferred(deferred, new V1SyncError(code, code));
    for (const deferred of this.#chatPages.values()) rejectV1Deferred(deferred, new V1SyncError(code, code));
    for (const deferred of this.#chatReads.values()) rejectV1Deferred(deferred, new V1SyncError(code, code));
    this.#reactions.clear();
    this.#chatSends.clear();
    this.#chatPages.clear();
    this.#chatReads.clear();
  }

  #sendTrackedRequest<Result>(requestId: string, frame: SyncV1ClientFrame, pending: Map<string, V1Deferred<Result>>): Promise<Result> {
    encodeV1ClientFrame(frame);
    const promise = new Promise<Result>((resolve, reject) => pending.set(requestId, { resolve, reject, settled: false }));
    this.#options.send(frame);
    return promise;
  }

  #observeChatMessage(frame: Extract<SyncV1ServerFrame, { readonly type: "chat_message" }>): void {
    this.#assertChatMessageVersion(frame);
    const message = chatMessageFromFrame(frame);
    this.#rememberChatSequence(message.sequence);
    this.#emit({ type: "chat_message", message });
  }

  #assertChatMessageVersion(frame: Extract<SyncV1ServerFrame, { readonly type: "chat_message" }>): void {
    if (this.#state.version === 1 && !("attachments" in frame)) throw new V1ReplicaError("collaboration_v1 received a chat message without attachments");
  }

  #rememberChatReadReceipt(receipt: ChalkChatReadReceipt): void {
    const existing = this.#state.readReceipts.find((candidate) => candidate.participantId === receipt.participantId && candidate.participantGeneration === receipt.participantGeneration);
    if (existing && compareUnsignedDecimals(existing.readThroughSequence, receipt.readThroughSequence) >= 0) return;
    this.#state = {
      ...this.#state,
      readReceipts: [...this.#state.readReceipts.filter((candidate) => candidate.participantId !== receipt.participantId || candidate.participantGeneration !== receipt.participantGeneration), receipt],
    };
  }

  #rememberChatSequence(sequence: string): void {
    if (this.#chatAfterSequence === null || compareUnsignedDecimals(sequence, this.#chatAfterSequence) > 0) this.#chatAfterSequence = sequence;
    if (this.#state.chatHeadSequence === null || compareUnsignedDecimals(sequence, this.#state.chatHeadSequence) > 0) this.#state = { ...this.#state, chatHeadSequence: sequence };
  }

  #assertReady(capability?: ChalkSyncV1CollaborationCapability): void {
    if (!this.#state.negotiated) throw new V1SyncError("collaboration is unavailable", "collaboration_unavailable");
    if (!this.#options.isLive()) throw new V1SyncError("collaboration requires a live connection", "not_live");
    if (capability && !this.#state.capabilities.includes(capability)) throw new V1SyncError("collaboration capability denied", "capability_denied");
  }

  #assertCapacity(): void {
    const maximum = Math.min(this.#options.maxPendingRequests ?? MAX_COLLABORATION_REQUESTS_IN_FLIGHT, MAX_COLLABORATION_REQUESTS_IN_FLIGHT);
    if (this.#reactions.size + this.#chatSends.size + this.#chatPages.size + this.#chatReads.size >= maximum) throw new V1SyncError("collaboration in-flight capacity exceeded", "capacity");
  }

  #assertRequestIdAvailable(id: string): void {
    if (this.#reactions.has(id) || this.#chatSends.has(id) || this.#chatPages.has(id) || this.#chatReads.has(id)) throw new V1SyncError("collaboration request ID is already pending", "request_id_conflict");
  }

  #nextRequestId(): string {
    const id = this.#options.requestIds?.next() ?? crypto.randomUUID();
    this.#assertRequestIdAvailable(id);
    return id;
  }

  #requireLive(): void {
    if (!this.#options.isLive()) throw new V1ReplicaError("live frame arrived before four-stream recovery completed");
  }

  #requireNegotiated(): void {
    if (!this.#state.negotiated) throw new V1ReplicaError("collaboration frame arrived without a negotiated extension");
  }

  #requireVersion(version: 1): void {
    this.#requireNegotiated();
    if (this.#state.version !== version) throw new V1ReplicaError("collaboration_v1 frame arrived on a different extension version");
  }

  #emit(event: V1CollaborationEvent): void {
    for (const listener of this.#listeners) listener(event);
  }
}

function copyCapabilities(capabilities: Readonly<Record<string, readonly ChalkSyncV1CollaborationCapability[]>>): Readonly<Record<string, readonly ChalkSyncV1CollaborationCapability[]>> {
  return Object.fromEntries(Object.entries(capabilities).map(([participantId, values]) => [participantId, [...values]]));
}

function chatReadReceiptFromWire(receipt: { readonly participant_id: string; readonly participant_generation: number; readonly sequence: string; readonly read_at: string }): ChalkChatReadReceipt {
  return {
    participantId: receipt.participant_id,
    participantGeneration: receipt.participant_generation,
    readThroughSequence: receipt.sequence,
    readAt: receipt.read_at,
  };
}

function compareUnsignedDecimals(left: string, right: string): number {
  if (left.length !== right.length) return left.length < right.length ? -1 : 1;
  return left === right ? 0 : left < right ? -1 : 1;
}
