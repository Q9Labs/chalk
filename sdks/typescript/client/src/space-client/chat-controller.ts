import { Context, Effect, Layer, Scope } from "effect";
import type { ChalkChatFileTransport } from "../chat-files";
import type { ChalkChatPageResult } from "../collaboration/types";
import type { ConnectionLifecycleCapability, ConnectionPorts } from "../connection";
import { chatDigest, chatMessageFor, chatReceiptFor, compareChatSequence, MAX_CHAT_PAGE_SIZE, MAX_LOADED_CHAT_MESSAGES, mergeChatMessage, validateChatMessage, validateChatUpload } from "./chat-controller-helpers";
import type { EpisodeDiagnosticRuntime } from "./episode-diagnostic-runtime";
import { failureFromError, normalizeClientError, SpaceClientError } from "./errors";
import { SpaceStore } from "./store";
import type { ChatAttachment, ChatMessage, ChatReadReceipt, ChatSendInput, ChatSlice, ChatUploadFile, PendingChatSend } from "./types";

type ClientEffect<A> = Effect.Effect<A, SpaceClientError>;
type Fork = (effect: Effect.Effect<void, unknown>) => void;

export type ChatControllerEffects = {
  readonly send: (input: ChatSendInput) => ClientEffect<ChatMessage>;
  readonly loadOlder: () => ClientEffect<ChalkChatPageResult>;
  readonly markRead: (messageId: string) => ClientEffect<ChatReadReceipt | null>;
  readonly upload: (file: ChatUploadFile) => ClientEffect<ChatAttachment>;
  readonly url: (attachment: ChatAttachment) => string;
  readonly dispose: () => void;
};
export class ChatControllerService extends Context.Service<ChatControllerService, ChatControllerEffects>()("@chalk/client/ChatController") {}

/** Scoped owner of chat subscriptions and catch-up fibers. */
export const makeChatController = (input: {
  readonly connection: ConnectionLifecycleCapability;
  readonly store: SpaceStore;
  readonly createTransport?: (input: { readonly token: () => Promise<string> }) => ChalkChatFileTransport | null;
  readonly apiBaseUrl?: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly episodeDiagnostics?: EpisodeDiagnosticRuntime;
}): Effect.Effect<ChatControllerEffects, never, Scope.Scope> =>
  Effect.gen(function* () {
    const scope = yield* Effect.scope;
    const context = yield* Effect.context<never>();
    const fork: Fork = (effect) => {
      void Effect.runForkWith(context)(Effect.forkIn(effect, scope).pipe(Effect.asVoid) as Effect.Effect<void>);
    };
    const controller = yield* Effect.sync(() => {
      let instance: ChatControllerRuntime | null = null;
      const transport = input.createTransport?.({ token: () => Effect.runPromiseWith(context)(input.connection.getSyncToken()) }) ?? null;
      instance = new ChatControllerRuntime(input.connection, input.store, transport, input.apiBaseUrl ?? "https://api.chalk.video", input.fetch ?? globalThis.fetch, fork, input.episodeDiagnostics);
      return instance;
    });
    yield* Effect.addFinalizer(() => Effect.sync(() => controller.dispose()));
    return controller;
  });

export const makeChatControllerLayer = (input: Parameters<typeof makeChatController>[0]) => Layer.effect(ChatControllerService, makeChatController(input));

class ChatControllerRuntime implements ChatControllerEffects {
  readonly #apiBaseUrl: string;
  readonly #connection: ConnectionLifecycleCapability;
  readonly #store: SpaceStore;
  readonly #transport: ChalkChatFileTransport | null;
  readonly #fetch: typeof globalThis.fetch;
  readonly #fork: Fork;
  readonly #diagnostics: EpisodeDiagnosticRuntime | undefined;
  #catchUpRunning = false;
  #catchUpRequested = false;
  #hasOlder = false;
  #historyTruncated = false;
  #initialCatchUpComplete = true;
  #lastError: ChatSlice["lastError"] = null;
  #localReadThroughSequence: string | null = null;
  #messages: readonly ChatMessage[] = Object.freeze([]);
  #pendingSends: readonly PendingChatSend[] = Object.freeze([]);
  #ports: ConnectionPorts | null = null;
  #readReceipts: readonly ChatReadReceipt[] = Object.freeze([]);
  #retainedFloorSequence: string | null = null;
  #status: ChatSlice["status"] = "idle";
  #unreadCount = 0;
  #unsubscribeConnection: (() => void) | null = null;
  #unsubscribeEvents: (() => void) | null = null;
  #unsubscribeSnapshot: (() => void) | null = null;

  constructor(connection: ConnectionLifecycleCapability, store: SpaceStore, transport: ChalkChatFileTransport | null, apiBaseUrl: string, fetch: typeof globalThis.fetch, fork: Fork, diagnostics?: EpisodeDiagnosticRuntime) {
    this.#apiBaseUrl = apiBaseUrl.replace(/\/+$/u, "");
    this.#connection = connection;
    this.#store = store;
    this.#transport = transport;
    this.#fetch = fetch;
    this.#fork = fork;
    this.#diagnostics = diagnostics;
    this.#unsubscribeConnection = connection.subscribePorts((ports) => this.#bind(ports));
  }

  send = (input: ChatSendInput): ClientEffect<ChatMessage> => {
    const operation = this.#diagnostics?.startOperation("chat.send");
    return Effect.try({ try: () => validate(input), catch: normalizeClientError }).pipe(
      Effect.tap(() => Effect.sync(() => operation?.observe("observed", "validation"))),
      Effect.map((attachments) => ({ clientMessageId: this.#connection.createId(), attachments })),
      Effect.flatMap(({ clientMessageId, attachments }) => {
        this.#upsertPending(clientMessageId, input.text, attachments, "sending", null);
        operation?.observe("observed", "authorization");
        return this.#connection
          .runCommand(({ sync }) => foreign(() => sync.sendChatMessage({ text: input.text, attachments, clientMessageId })))
          .pipe(Effect.tap(() => Effect.sync(() => operation?.observe("observed", "durable_commit"))))
          .pipe(
            Effect.map(chatMessageFor),
            Effect.tap(() => Effect.sync(() => this.#removePending(clientMessageId))),
            Effect.map((message) => this.#observeMessage(message, false)),
            Effect.tap(() =>
              Effect.sync(() => {
                operation?.observe("observed", "paging_visibility");
                operation?.notObservable("recipient_projection", "recipient_projection_is_conditional");
                operation?.succeed();
              }),
            ),
            Effect.catch((cause) => {
              const error = normalizeClientError(cause, "chat.payload_invalid");
              return Effect.sync(() => {
                this.#upsertPending(clientMessageId, input.text, attachments, "failed", failureFromError(error));
                operation?.fail("send_failed");
              }).pipe(Effect.andThen(Effect.fail(error)));
            }),
          );
      }),
      Effect.mapError(normalizeClientError),
      Effect.tapError(() => Effect.sync(() => operation?.fail("send_failed"))),
    );
  };

  loadOlder = (): ClientEffect<ChalkChatPageResult> => {
    const operation = this.#diagnostics?.startOperation("chat.page");
    this.#status = "loading";
    this.#lastError = null;
    this.#publish();
    return this.#connection
      .runCommand(({ sync }) => foreign(() => sync.readChatPage({ beforeSequence: this.#messages[0]?.sequence, limit: MAX_CHAT_PAGE_SIZE })))
      .pipe(
        Effect.tap((result) =>
          Effect.sync(() => {
            this.#applyPage(result);
            operation?.observe("observed", "page_visibility");
            operation?.succeed();
          }),
        ),
        Effect.mapError((cause) => {
          const error = normalizeClientError(cause, "chat.payload_invalid");
          this.#status = "failed";
          this.#lastError = failureFromError(error);
          this.#publish();
          return error;
        }),
        Effect.tapError(() => Effect.sync(() => operation?.fail("page_failed"))),
      );
  };

  markRead = (messageId: string): ClientEffect<ChatReadReceipt | null> => {
    const operation = this.#diagnostics?.startOperation("chat.read");
    return Effect.suspend(() => {
      const message = this.#messages.find((candidate) => candidate.messageId === messageId);
      if (!message) {
        operation?.notObservable("read_commit", "message_not_found");
        operation?.succeed();
        return Effect.succeed(null);
      }
      this.#applyLocalReadThrough(message.sequence);
      const ports = this.#ports;
      if (!ports || ports.sync.getCollaborationExtensionState().version !== 1) {
        operation?.notObservable("read_commit", "collaboration_extension_unavailable");
        operation?.succeed();
        return Effect.succeed(null);
      }
      operation?.observe("observed", "read_commit");
      return this.#connection
        .runCommand(({ sync }) => foreign(() => sync.markChatRead(message.sequence)))
        .pipe(
          Effect.map(chatReceiptFor),
          Effect.tap((receipt) => Effect.sync(() => this.#mergeReceipt(receipt))),
          Effect.tap(() => Effect.sync(() => operation?.succeed())),
          Effect.mapError(normalizeClientError),
          Effect.tapError(() => Effect.sync(() => operation?.fail("read_failed"))),
        );
    });
  };

  upload = (file: ChatUploadFile): ClientEffect<ChatAttachment> => {
    const prepareOperation = this.#diagnostics?.startOperation("chat.attachment.prepare");
    return Effect.suspend(() => {
      if (!this.#transport) {
        prepareOperation?.fail("transport_unavailable");
        return Effect.fail(new SpaceClientError({ code: "collaboration.unavailable", recoverable: false, message: "Chat file upload is unavailable" }));
      }
      return bytesFor(file).pipe(
        Effect.flatMap((bytes) => {
          const clientAttachmentId = this.#connection.createId();
          return Effect.try({ try: () => validateUpload(file, bytes, clientAttachmentId), catch: normalizeClientError }).pipe(
            Effect.tap(() => Effect.sync(() => prepareOperation?.observe("observed", "validation"))),
            Effect.flatMap((uploadFile) =>
              this.#connection.runPortCommand(() =>
                foreign(() => this.#transport!.initiateUpload({ clientAttachmentId, fileName: uploadFile.fileName, mimeType: uploadFile.mimeType, byteLength: bytes.byteLength, sha256: chatDigest(bytes) })).pipe(
                  Effect.flatMap((upload) =>
                    Effect.sync(() => {
                      prepareOperation?.observe("observed", "storage_prepare");
                      prepareOperation?.succeed();
                    }).pipe(
                      Effect.andThen(
                        foreign(() => this.#fetch(upload.uploadUrl, { method: upload.method, headers: upload.headers, body: bytes })).pipe(
                          Effect.flatMap((response) => {
                            const commitOperation = this.#diagnostics?.startOperation("chat.attachment.commit");
                            if (!response.ok) {
                              commitOperation?.fail("storage_rejected");
                              return Effect.fail(new SpaceClientError({ code: "command.rejected", recoverable: response.status >= 500, message: `Attachment upload failed with HTTP ${response.status}` }));
                            }
                            return foreign(() => this.#transport!.finalizeUpload(upload.uploadId)).pipe(
                              Effect.tap(() =>
                                Effect.sync(() => {
                                  commitOperation?.observe("observed", "storage_commit");
                                  commitOperation?.succeed();
                                }),
                              ),
                              Effect.tapError(() => Effect.sync(() => commitOperation?.fail("storage_commit_failed"))),
                            );
                          }),
                        ),
                      ),
                    ),
                  ),
                ),
              ),
            ),
          );
        }),
        Effect.mapError(normalizeClientError),
        Effect.tapError(() =>
          Effect.sync(() => {
            prepareOperation?.fail("upload_failed");
            const failureOperation = this.#diagnostics?.startOperation("chat.attachment.fail");
            failureOperation?.observe("observed", "failure");
            failureOperation?.succeed();
          }),
        ),
      );
    });
  };

  url = (attachment: ChatAttachment): string => `${this.#apiBaseUrl}/v1/chat/attachments/${encodeURIComponent(attachment.attachmentId)}/download`;
  dispose(): void {
    this.#unsubscribeConnection?.();
    this.#unsubscribeConnection = null;
    this.#unsubscribeEvents?.();
    this.#unsubscribeSnapshot?.();
    this.#unsubscribeEvents = null;
    this.#unsubscribeSnapshot = null;
    this.#ports = null;
  }

  #bind(ports: ConnectionPorts | null): void {
    this.#unsubscribeEvents?.();
    this.#unsubscribeSnapshot?.();
    this.#unsubscribeEvents = null;
    this.#unsubscribeSnapshot = null;
    this.#ports = ports;
    if (!ports) return this.#reset();
    this.#status = "ready";
    this.#initialCatchUpComplete = ports.sync.getCollaborationExtensionState().chatHeadSequence === null;
    this.#unsubscribeEvents = ports.sync.subscribeCollaboration((event) => {
      if (event.type === "chat_message") this.#observeMessage(chatMessageFor(event.message), this.#initialCatchUpComplete);
      else if (event.type === "chat_read_receipt") this.#mergeReceipt(chatReceiptFor(event.receipt));
      else if (event.type === "chat_cursor_reset") this.#applyCursorReset(event.retainedFloorSequence);
    });
    this.#unsubscribeSnapshot = ports.sync.subscribe(() => this.#scheduleCatchUp());
    this.#scheduleCatchUp();
    this.#publish();
  }

  #scheduleCatchUp(): void {
    const ports = this.#ports;
    if (!ports || ports.sync.getSnapshot().connection.phase !== "live" || !catchUpRequest(this.#messages.at(-1)?.sequence ?? null, ports)) return;
    if (this.#catchUpRunning) {
      this.#catchUpRequested = true;
      return;
    }
    this.#catchUpRunning = true;
    this.#fork(
      this.#catchUp(ports).pipe(
        Effect.catch((cause) =>
          Effect.sync(() => {
            if (this.#ports !== ports) return;
            const error = normalizeClientError(cause, "chat.payload_invalid");
            this.#status = "failed";
            this.#lastError = failureFromError(error);
            this.#publish();
          }),
        ),
        Effect.ensuring(
          Effect.sync(() => {
            this.#catchUpRunning = false;
            this.#initialCatchUpComplete = true;
            if (this.#catchUpRequested) {
              this.#catchUpRequested = false;
              this.#scheduleCatchUp();
            }
          }),
        ),
      ),
    );
  }

  #catchUp(ports: ConnectionPorts): Effect.Effect<void, unknown> {
    return Effect.suspend(() => {
      if (this.#ports !== ports || ports.sync.getSnapshot().connection.phase !== "live") return Effect.void;
      const request = catchUpRequest(this.#messages.at(-1)?.sequence ?? null, ports);
      if (!request) return Effect.void;
      return foreign(() => ports.sync.readChatPage(request.input)).pipe(
        Effect.flatMap((result) => {
          if (this.#ports !== ports) return Effect.void;
          if (result.status === "cursor_reset") return Effect.sync(() => this.#applyCursorReset(result.retainedFloorSequence)).pipe(Effect.andThen(this.#reloadAfterCursorReset(ports)));
          if (request.kind === "initial") {
            this.#hasOlder = result.hasOlder;
            this.#publish();
          }
          return result.hasOlder ? this.#catchUp(ports) : Effect.void;
        }),
      );
    });
  }

  #reloadAfterCursorReset(ports: ConnectionPorts): Effect.Effect<void, unknown> {
    return foreign(() => ports.sync.readChatPage({ limit: MAX_CHAT_PAGE_SIZE })).pipe(
      Effect.tap((result) =>
        Effect.sync(() => {
          if (this.#ports !== ports || result.status === "cursor_reset") return;
          this.#hasOlder = result.hasOlder;
          this.#publish();
        }),
      ),
      Effect.asVoid,
    );
  }

  #applyPage(result: ChalkChatPageResult): void {
    this.#status = "ready";
    if (result.status === "cursor_reset") this.#applyCursorReset(result.retainedFloorSequence);
    else {
      this.#hasOlder = result.hasOlder;
      this.#publish();
    }
  }
  #applyCursorReset(retainedFloorSequence: string): void {
    this.#status = "ready";
    this.#hasOlder = false;
    this.#historyTruncated = true;
    this.#retainedFloorSequence = retainedFloorSequence;
    this.#publish();
  }
  #observeMessage(message: ChatMessage, countUnread: boolean): ChatMessage {
    const existing = this.#messages.find((candidate) => candidate.messageId === message.messageId || candidate.sequence === message.sequence);
    const next = this.#messagesWith(message, existing);
    const pendingSends = this.#pendingSends.filter((pending) => pending.clientMessageId !== message.clientMessageId);
    const unread = this.#unreadCountFor(message, existing, countUnread);
    if (this.#messageStateMatches(next, pendingSends, unread)) return existing ?? message;
    this.#messages = next;
    this.#pendingSends = Object.freeze(pendingSends);
    this.#unreadCount = unread;
    this.#status = "ready";
    this.#lastError = null;
    this.#publish();
    return message;
  }
  #messagesWith(message: ChatMessage, existing: ChatMessage | undefined): readonly ChatMessage[] {
    if (existing) return mergeChatMessage(this.#messages, existing, message);
    return Object.freeze([...this.#messages, message].sort((left, right) => compareChatSequence(left.sequence, right.sequence)).slice(-MAX_LOADED_CHAT_MESSAGES));
  }
  #unreadCountFor(message: ChatMessage, existing: ChatMessage | undefined, countUnread: boolean): number {
    if (!countUnread || existing || message.participantId === this.#connection.getSnapshot().subject?.participantId) return this.#unreadCount;
    if (this.#localReadThroughSequence !== null && compareChatSequence(message.sequence, this.#localReadThroughSequence) <= 0) return this.#unreadCount;
    return this.#unreadCount + 1;
  }
  #messageStateMatches(messages: readonly ChatMessage[], pendingSends: readonly PendingChatSend[], unread: number): boolean {
    return messages === this.#messages && pendingSends.length === this.#pendingSends.length && unread === this.#unreadCount && this.#status === "ready" && this.#lastError === null;
  }
  #mergeReceipt(receipt: ChatReadReceipt): void {
    const existing = this.#readReceipts.find((candidate) => candidate.participantId === receipt.participantId && candidate.participantGeneration === receipt.participantGeneration);
    if (existing && compareChatSequence(existing.readThroughSequence, receipt.readThroughSequence) >= 0) return;
    this.#readReceipts = Object.freeze([...this.#readReceipts.filter((candidate) => candidate.participantId !== receipt.participantId || candidate.participantGeneration !== receipt.participantGeneration), receipt]);
    const subject = this.#connection.getSnapshot().subject;
    if (subject?.participantId === receipt.participantId && subject.participantGeneration === receipt.participantGeneration) this.#applyLocalReadThrough(receipt.readThroughSequence, false);
    this.#publish();
  }
  #applyLocalReadThrough(sequence: string, publish = true): void {
    if (this.#localReadThroughSequence && compareChatSequence(this.#localReadThroughSequence, sequence) >= 0) return;
    this.#localReadThroughSequence = sequence;
    const local = this.#connection.getSnapshot().subject?.participantId;
    this.#unreadCount = this.#messages.filter((message) => message.participantId !== local && compareChatSequence(message.sequence, sequence) > 0).length;
    if (publish) this.#publish();
  }
  #upsertPending(clientMessageId: string, text: string, attachments: readonly ChatAttachment[], status: PendingChatSend["status"], error: PendingChatSend["error"]): void {
    const pending: PendingChatSend = Object.freeze({ clientMessageId, text, attachments: Object.freeze([...attachments]), status, error });
    this.#pendingSends = Object.freeze([...this.#pendingSends.filter((candidate) => candidate.clientMessageId !== clientMessageId), pending]);
    this.#status = "ready";
    this.#lastError = null;
    this.#publish();
  }
  #removePending(clientMessageId: string): void {
    const next = this.#pendingSends.filter((candidate) => candidate.clientMessageId !== clientMessageId);
    if (next.length === this.#pendingSends.length) return;
    this.#pendingSends = Object.freeze(next);
    this.#publish();
  }
  #reset(): void {
    this.#catchUpRequested = false;
    this.#hasOlder = false;
    this.#historyTruncated = false;
    this.#initialCatchUpComplete = true;
    this.#lastError = null;
    this.#localReadThroughSequence = null;
    this.#messages = Object.freeze([]);
    this.#pendingSends = Object.freeze([]);
    this.#readReceipts = Object.freeze([]);
    this.#retainedFloorSequence = null;
    this.#status = "idle";
    this.#unreadCount = 0;
    this.#publish();
  }
  #publish(): void {
    this.#store.updateChat(
      Object.freeze({
        status: this.#status,
        messages: this.#messages,
        pendingSends: this.#pendingSends,
        readReceipts: this.#readReceipts,
        unreadCount: this.#unreadCount,
        pagination: Object.freeze({ cursor: this.#retainedFloorSequence ?? this.#messages[0]?.sequence ?? null, hasOlder: this.#hasOlder, historyTruncated: this.#historyTruncated }),
        lastError: this.#lastError,
      }),
    );
  }
}

function foreign<A>(operation: () => Promise<A>): Effect.Effect<A, unknown> {
  return Effect.tryPromise({ try: operation, catch: (cause) => cause });
}
function validate(input: ChatSendInput): readonly ChatAttachment[] {
  const validation = validateChatMessage(input);
  if (validation) throw chatError(validation);
  return input.attachments ?? [];
}
function validateUpload(file: ChatUploadFile, bytes: ArrayBuffer, clientAttachmentId: string) {
  const upload = validateChatUpload(file, bytes, clientAttachmentId);
  if (typeof upload === "string") throw chatError(upload);
  return upload;
}
function bytesFor(file: ChatUploadFile): Effect.Effect<ArrayBuffer, unknown> {
  return "bytes" in file ? Effect.succeed(file.bytes) : foreign(() => file.arrayBuffer());
}
function catchUpRequest(latestSequence: string | null, ports: ConnectionPorts): { readonly kind: "initial" | "newer"; readonly input: { readonly limit: number; readonly afterSequence?: string } } | null {
  const extension = ports.sync.getCollaborationExtensionState();
  const head = extension.chatHeadSequence;
  if (!extension.negotiated || head === null || (latestSequence !== null && compareChatSequence(latestSequence, head) >= 0)) return null;
  return latestSequence === null ? { kind: "initial", input: { limit: MAX_CHAT_PAGE_SIZE } } : { kind: "newer", input: { afterSequence: latestSequence, limit: MAX_CHAT_PAGE_SIZE } };
}
function chatError(message: string): SpaceClientError {
  return new SpaceClientError({ code: "chat.payload_invalid", recoverable: false, message });
}
