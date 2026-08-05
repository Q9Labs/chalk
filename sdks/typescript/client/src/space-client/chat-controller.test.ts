import { Effect, Layer, ManagedRuntime } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChalkChatFileTransport } from "../chat-files";
import type { ConnectionLifecycleCapability, ConnectionPorts } from "../connection";
import { ChatControllerService, makeChatController } from "./chat-controller";
import { SpaceStore } from "./store";

const runtimes: ManagedRuntime.ManagedRuntime<ChatControllerService, never>[] = [];

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.dispose()));
  vi.unstubAllGlobals();
});

describe("ChatController", () => {
  it("validates input, keeps a failed optimistic send, and merges its acknowledged event", async () => {
    const harness = createHarness();
    harness.connection.setPorts(harness.ports);

    await expect(harness.runtime.runPromise(harness.controller.send({ text: "" }))).rejects.toMatchObject({ code: "chat.payload_invalid" });
    expect(harness.sync.sendChatMessage).not.toHaveBeenCalled();

    harness.sync.sendChatMessage.mockRejectedValueOnce(new Error("temporary failure"));
    await expect(harness.runtime.runPromise(harness.controller.send({ text: "hello" }))).rejects.toMatchObject({ code: "chat.payload_invalid" });
    expect(harness.store.getSnapshot().chat.pendingSends).toEqual([expect.objectContaining({ text: "hello", status: "failed" })]);

    harness.sync.sendChatMessage.mockImplementationOnce(async (input) => {
      const message = chatMessage("2", input.clientMessageId);
      harness.sync.emitCollaboration({ type: "chat_message", message });
      return message;
    });
    await harness.runtime.runPromise(harness.controller.send({ text: "hello again" }));
    expect(harness.store.getSnapshot().chat).toMatchObject({ messages: [expect.objectContaining({ sequence: "2", text: "Message 2" })], pendingSends: [expect.objectContaining({ status: "failed" })] });
  });

  it("keeps durable receipts monotonic and clears unread messages through the local watermark", async () => {
    const harness = createHarness();
    harness.connection.setPorts(harness.ports);

    harness.sync.emitCollaboration({ type: "chat_message", message: chatMessage("2") });
    expect(harness.store.getSnapshot().chat.unreadCount).toBe(1);

    await harness.runtime.runPromise(harness.controller.markRead("message-2"));
    expect(harness.store.getSnapshot().chat.unreadCount).toBe(0);
    expect(harness.sync.markChatRead).toHaveBeenCalledWith("2");

    harness.sync.emitCollaboration({ type: "chat_read_receipt", receipt: receipt("participant-2", "2") });
    harness.sync.emitCollaboration({ type: "chat_read_receipt", receipt: receipt("participant-2", "1") });
    expect(harness.store.getSnapshot().chat.readReceipts).toEqual(expect.arrayContaining([expect.objectContaining({ participantId: "participant-2", readThroughSequence: "2" })]));
  });

  it("catches up initial and newer pages, then maps a cursor reset into pagination", async () => {
    const harness = createHarness();
    harness.sync.head = "2";
    let latestReads = 0;
    harness.sync.readChatPage.mockImplementation(async (input) => {
      if (input.afterSequence === "2") return { status: "cursor_reset" as const, retainedFloorSequence: "8" };
      latestReads += 1;
      harness.sync.emitCollaboration({ type: "chat_message", message: chatMessage(latestReads === 1 ? "2" : "9") });
      return { status: "loaded" as const, count: 1, hasOlder: latestReads === 2 };
    });
    harness.connection.setPorts(harness.ports);
    await vi.waitFor(() => expect(harness.store.getSnapshot().chat.messages).toEqual([expect.objectContaining({ sequence: "2" })]));
    expect(harness.store.getSnapshot().chat.unreadCount).toBe(0);

    harness.sync.head = "9";
    harness.sync.emitSnapshot();
    await vi.waitFor(() => expect(latestReads).toBe(2));
    expect(harness.store.getSnapshot().chat).toMatchObject({
      messages: [expect.objectContaining({ sequence: "2" }), expect.objectContaining({ sequence: "9" })],
      pagination: { cursor: "8", hasOlder: true, historyTruncated: true },
      unreadCount: 1,
    });
  });

  it("validates, digests, uploads, and finalizes attachments through the access gate", async () => {
    const upload: ChalkChatFileTransport = {
      initiateUpload: vi.fn(async () => ({ attachmentId: "attachment-1", uploadId: "upload-1", method: "PUT" as const, uploadUrl: "https://upload.test/object", headers: { "content-type": "text/plain" }, expiresAt: "2026-08-04T12:05:00.000Z" })),
      finalizeUpload: vi.fn(async () => ({ attachmentId: "attachment-1", fileName: "note.txt", mimeType: "text/plain" as const, byteLength: 5 })),
      getDownloadUrl: vi.fn(),
    };
    const fetch = vi.fn(async () => new Response(null, { status: 200 }));
    const harness = createHarness(upload, fetch);

    await expect(harness.runtime.runPromise(harness.controller.upload({ fileName: "note.txt", mimeType: "text/plain", bytes: new TextEncoder().encode("hello").buffer }))).resolves.toMatchObject({ attachmentId: "attachment-1" });
    expect(upload.initiateUpload).toHaveBeenCalledWith(expect.objectContaining({ sha256: expect.stringMatching(/^[a-f0-9]{64}$/u) }));
    expect(fetch).toHaveBeenCalledWith("https://upload.test/object", expect.objectContaining({ headers: { "content-type": "text/plain" } }));
    expect(upload.finalizeUpload).toHaveBeenCalledWith("upload-1");
    expect(harness.controller.url({ attachmentId: "attachment/1", fileName: "note.txt", mimeType: "text/plain", byteLength: 5 })).toBe("https://api.chalk.video/v1/chat/attachments/attachment%2F1/download");
  });
});

function createHarness(transport: ChalkChatFileTransport | null = null, fetch?: typeof globalThis.fetch) {
  const store = new SpaceStore();
  const connection = new FakeConnection();
  const sync = new FakeSync();
  const ports = { sync, media: {} } as unknown as ConnectionPorts;
  const runtime = ManagedRuntime.make(Layer.effect(ChatControllerService, makeChatController({ connection: connection as unknown as ConnectionLifecycleCapability, store, createTransport: transport ? () => transport : undefined, fetch })) as Layer.Layer<ChatControllerService, never>);
  runtimes.push(runtime);
  return { store, connection, controller: runtime.runSync(Effect.service(ChatControllerService)), runtime, sync, ports };
}

function chatMessage(sequence: string, clientMessageId = `client-${sequence}`) {
  return { messageId: `message-${sequence}`, clientMessageId, sequence, participantId: sequence === "2" || sequence === "9" ? "participant-2" : "participant-1", displayName: "Grace", text: `Message ${sequence}`, createdAt: "2026-08-04T12:00:00.000Z", attachments: [] };
}

function receipt(participantId: string, readThroughSequence: string) {
  return { participantId, participantGeneration: 1, readThroughSequence, readAt: "2026-08-04T12:00:00.000Z" };
}

class FakeConnection {
  #identifier = 0;
  #listeners = new Set<(ports: ConnectionPorts | null) => void>();
  #ports: ConnectionPorts | null = null;
  readonly getSnapshot = () => ({ subject: { participantId: "participant-1", participantGeneration: 1 } });
  readonly getSyncToken = () => Effect.succeed("access-token");
  readonly runCommand = <T, E>(operation: (ports: ConnectionPorts) => Effect.Effect<T, E>): Effect.Effect<T, E | Error> => Effect.suspend(() => (this.#ports ? operation(this.#ports) : Effect.fail(new Error("not live"))));
  readonly runPortCommand = <T, E>(operation: () => Effect.Effect<T, E>): Effect.Effect<T, E> => Effect.suspend(operation);
  createId = (): string => `client-${++this.#identifier}`;
  readonly subscribePorts = (listener: (ports: ConnectionPorts | null) => void): (() => void) => {
    this.#listeners.add(listener);
    listener(this.#ports);
    return () => this.#listeners.delete(listener);
  };
  setPorts(ports: ConnectionPorts | null): void {
    this.#ports = ports;
    for (const listener of this.#listeners) listener(ports);
  }
}

class FakeSync {
  head: string | null = null;
  readonly events = new Set<
    (
      event:
        | { readonly type: "chat_message"; readonly message: ReturnType<typeof chatMessage> }
        | { readonly type: "chat_read_receipt"; readonly receipt: ReturnType<typeof receipt> }
        | { readonly type: "chat_cursor_reset"; readonly retainedFloorSequence: string }
        | { readonly type: "reaction"; readonly reaction: never },
    ) => void
  >();
  readonly snapshots = new Set<() => void>();
  readonly sendChatMessage = vi.fn(async (input: { readonly text: string; readonly clientMessageId?: string }) => chatMessage("1", input.clientMessageId));
  readonly markChatRead = vi.fn(async (sequence: string) => receipt("participant-1", sequence));
  readonly readChatPage = vi.fn(async () => ({ status: "loaded" as const, count: 0, hasOlder: false }));
  readonly getSnapshot = () => ({ connection: { phase: "live" } });
  readonly getCollaborationExtensionState = () => ({ negotiated: true, version: 1 as const, capabilities: ["sendChat"] as const, chatHeadSequence: this.head, retainedFloorSequence: null, readReceipts: [] });
  readonly subscribeCollaboration = (listener: (event: typeof this.events extends Set<infer T> ? T : never) => void): (() => void) => {
    this.events.add(listener);
    return () => this.events.delete(listener);
  };
  readonly subscribe = (listener: () => void): (() => void) => {
    this.snapshots.add(listener);
    listener();
    return () => this.snapshots.delete(listener);
  };

  emitCollaboration(event: Parameters<typeof this.events extends Set<infer T> ? T : never>[0]): void {
    for (const listener of this.events) listener(event);
  }

  emitSnapshot(): void {
    for (const listener of this.snapshots) listener();
  }
}
