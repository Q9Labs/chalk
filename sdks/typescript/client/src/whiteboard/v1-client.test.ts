import { describe, expect, it } from "vitest";
import type { SyncSocket } from "../sync/types";
import { ChalkWhiteboardV1Client } from "./v1-client";
import { InMemoryChalkWhiteboardV1PendingOperationStore } from "./v1-persistence";
import type { ChalkWhiteboardV1FileTransport } from "./types";

const participantId = "018f2f65-2a77-7a44-8e9a-5b0b6f8d4c21";
const sceneId = "018f2f65-2a77-7a44-8e9a-5b0b6f8d4c22";
const nextSceneId = "018f2f65-2a77-7a44-8e9a-5b0b6f8d4c23";
const ids = Array.from({ length: 20 }, (_, index) => `018f2f65-2a77-7a44-8e9a-${(0x5b0b6f8d4d00 + index).toString(16)}`);

describe("ChalkWhiteboardV1Client", () => {
  it("authenticates with the participant token and assembles an acknowledged snapshot", async () => {
    const summaries: unknown[] = [];
    const { client, socket, started } = await connectingClient({ onSummary: (summary) => summaries.push(summary) });
    expect(socket.frames()[0]).toEqual({
      type: "hello",
      protocol: "whiteboard-v1",
      token: "participant-token",
      cursor: null,
    });

    welcome(socket);
    await settle();
    const request = socket.frames().find((frame) => frame.type === "request_snapshot")!;
    const events: unknown[] = [];
    socket.receive({
      type: "snapshot_page",
      request_id: request.request_id,
      scene_id: sceneId,
      revision: "4",
      page: 0,
      page_count: 1,
      elements: [wireElement("element-1")],
      app_state: { view_background_color: "#ffffff" },
    });

    await expect(started).resolves.toBeUndefined();
    client.subscribe((event) => events.push(event));
    expect(socket.frames().at(-1)).toEqual({
      type: "snapshot_ack",
      request_id: request.request_id,
      scene_id: sceneId,
      revision: "4",
      page: 0,
    });
    expect(events).toEqual([
      {
        type: "snapshot",
        sceneId,
        revision: "4",
        elements: [publicElement("element-1")],
        appState: { viewBackgroundColor: "#ffffff" },
      },
    ]);
    expect(summaries.at(-1)).toEqual({
      status: "ready",
      sceneId,
      revision: "4",
      capabilities: ["drawWhiteboard", "manageWhiteboard"],
      canDraw: true,
      canClear: true,
      error: null,
    });
    client.stopSceneSubscription();
    expect(summaries.at(-1)).toMatchObject({ status: "unsubscribed", canDraw: false, canClear: false });
  });

  it("persists updates before send and clears the retry row after a commit", async () => {
    const store = new InMemoryChalkWhiteboardV1PendingOperationStore();
    const { client, socket, started } = await connectingClient({ pendingStore: store });
    welcome(socket);
    await finishInitialSnapshot(socket, started);

    const committed = client.submitUpdate({
      sceneId,
      syncAll: false,
      elements: [publicElement("element-2")],
    });
    await settle();
    const update = socket.frames().at(-1)!;
    expect(update).toMatchObject({
      type: "submit_update",
      scene_id: sceneId,
      sync_all: false,
      elements: [{ version_nonce: 7, is_deleted: false }],
    });
    expect(await store.load()).toHaveLength(1);

    socket.receive({
      type: "commit",
      operation_id: update.operation_id,
      outcome: "committed",
      scene_id: sceneId,
      revision: "5",
    });
    await expect(committed).resolves.toEqual({
      operationId: update.operation_id,
      sceneId,
      revision: "5",
    });
    await settle();
    expect(await store.load()).toEqual([]);
    client.stopSceneSubscription();
  });

  it("sends and receives multipart updates as one logical operation", async () => {
    const { client, socket, events } = await subscribedClient();
    const elements = Array.from({ length: 129 }, (_, index) => publicElement(`element-${index}`));

    const committed = client.submitUpdate({ sceneId, syncAll: true, elements });
    await settle();
    const parts = socket.frames().filter((frame) => frame.type === "submit_update_part");
    expect(parts).toHaveLength(2);
    expect(new Set(parts.map((part) => part.operation_id))).toEqual(new Set([parts[0]!.operation_id]));

    const updateParts = parts.map((part) => ({
      type: "update_part",
      operation_id: part.operation_id,
      scene_id: part.scene_id,
      revision: "4",
      part: part.part,
      part_count: part.part_count,
      element_count: part.element_count,
      elements: part.elements,
    }));
    socket.receive(updateParts[1]);
    await settle();
    expect(events).toEqual([]);

    socket.receive(updateParts[0]);
    await settle();
    expect(events).toEqual([
      expect.objectContaining({
        type: "update",
        sceneId,
        revision: "4",
        elements,
      }),
    ]);

    socket.receive({
      type: "commit",
      operation_id: parts[0]!.operation_id,
      outcome: "committed",
      scene_id: sceneId,
      revision: "4",
    });
    await expect(committed).resolves.toMatchObject({ sceneId, revision: "4" });
    client.stopSceneSubscription();
  });

  it("retries stable operation IDs and throttles transient cursors independently", async () => {
    const clock = new TestClock();
    const { client, socket, started } = await connectingClient({ clock, retryDelayMs: 100 });
    welcome(socket);
    await finishInitialSnapshot(socket, started);
    const updatePromise = client.submitUpdate({ sceneId, syncAll: true, elements: [] });
    await settle();
    const update = socket.frames().at(-1)!;

    socket.receive({
      type: "operation_error",
      correlation_id: update.operation_id,
      operation: "submit_update",
      code: "overloaded",
      recoverable: true,
      message: "Retry later.",
    });
    await settle();
    clock.advance(100);
    expect(socket.frames().filter((frame) => frame.type === "submit_update")).toHaveLength(2);
    expect(
      new Set(
        socket
          .frames()
          .filter((frame) => frame.type === "submit_update")
          .map((frame) => frame.operation_id),
      ),
    ).toEqual(new Set([update.operation_id]));

    client.sendCursor({ x: 1, y: 2 });
    client.sendCursor({ x: 3, y: 4 });
    clock.advance(17);
    client.sendCursor({ x: 5, y: 6 });
    expect(socket.frames().filter((frame) => frame.type === "cursor")).toEqual([
      { type: "cursor", x: 1, y: 2 },
      { type: "cursor", x: 5, y: 6 },
    ]);

    client.stopSceneSubscription();
    await expect(updatePromise).rejects.toMatchObject({ code: "unavailable", operation: "submit_update" });
  });

  it("uses the canonical participant wire field and public event name", async () => {
    const { client, socket, events } = await subscribedClient();
    socket.receive({
      type: "cursor",
      participant_id: participantId,
      display_name: "Ada",
      x: 1,
      y: 2,
      occurred_at: "2026-08-04T12:00:00.000Z",
    });
    const permission = client.setDrawPermission(participantId, false);
    await settle();
    const permissionFrame = socket.frames().at(-1)!;
    socket.receive({
      type: "commit",
      operation_id: permissionFrame.operation_id,
      outcome: "committed",
      scene_id: sceneId,
      revision: "4",
    });
    await permission;

    expect(events).toContainEqual({ type: "cursor", participantId, displayName: "Ada", x: 1, y: 2, occurredAt: "2026-08-04T12:00:00.000Z" });
    expect(permissionFrame).toEqual(expect.objectContaining({ type: "set_draw_permission", participant_id: participantId, can_draw: false }));
    client.stopSceneSubscription();
  });
});

async function connectingClient(overrides: Partial<ConstructorParameters<typeof ChalkWhiteboardV1Client>[0]> = {}) {
  const socket = new TestSocket();
  const availableIds = [...ids];
  const client = new ChalkWhiteboardV1Client({
    url: "ws://sync.test/v1/whiteboard",
    token: async () => "participant-token",
    files: filesStub,
    ids: { next: () => availableIds.shift()! },
    webSocket: { connect: () => socket },
    ...overrides,
  });
  const started = client.startSceneSubscription();
  await settle();
  socket.open();
  await settle();
  return { client, socket, started };
}

async function subscribedClient(overrides: Partial<ConstructorParameters<typeof ChalkWhiteboardV1Client>[0]> = {}) {
  const { client, socket, started } = await connectingClient(overrides);
  welcome(socket);
  await finishInitialSnapshot(socket, started);
  const events: unknown[] = [];
  client.subscribe((event) => events.push(event));
  events.length = 0;
  return { client, socket, events };
}

function welcome(socket: TestSocket): void {
  socket.receive({
    type: "welcome",
    protocol: "whiteboard-v1",
    participant_id: participantId,
    participant_generation: 1,
    capabilities: ["drawWhiteboard", "manageWhiteboard"],
    participant_capabilities: ["drawWhiteboard", "manageWhiteboard"],
    scene_id: sceneId,
    revision: "3",
    can_draw: true,
  });
}

async function finishInitialSnapshot(socket: TestSocket, started: Promise<void>): Promise<void> {
  await settle();
  const request = socket.frames().find((frame) => frame.type === "request_snapshot")!;
  socket.receive({
    type: "snapshot_page",
    request_id: request.request_id,
    scene_id: sceneId,
    revision: "3",
    page: 0,
    page_count: 1,
    elements: [],
    app_state: null,
  });
  await started;
}

function wireElement(id: string) {
  return {
    id,
    type: "rectangle",
    version: 2,
    version_nonce: 7,
    index: "a0",
    is_deleted: false,
    payload: { x: 1, y: 2 },
  } as const;
}

function publicElement(id: string) {
  return {
    id,
    type: "rectangle",
    version: 2,
    versionNonce: 7,
    index: "a0",
    isDeleted: false,
    payload: { x: 1, y: 2 },
  } as const;
}

const filesStub: ChalkWhiteboardV1FileTransport = {
  initiateUpload: async () => ({
    uploadId: ids[15]!,
    method: "PUT",
    uploadUrl: "https://uploads.test/object",
    headers: {},
    expiresAt: "2026-07-29T12:00:00.000Z",
  }),
  finalizeUpload: async () => undefined,
  getDownloadUrl: async () => ({
    downloadUrl: "https://downloads.test/object",
    expiresAt: "2026-07-29T12:00:00.000Z",
  }),
};

class TestSocket implements SyncSocket {
  onopen: (() => void) | null = null;
  onmessage: ((event: { readonly data: unknown }) => void) | null = null;
  onclose: ((event: { readonly code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  readonly sent: string[] = [];

  readonly send = (data: string): void => {
    this.sent.push(data);
  };

  readonly close = (code = 1000): void => {
    this.onclose?.({ code });
  };

  readonly open = (): void => {
    this.onopen?.();
  };

  readonly receive = (frame: unknown): void => {
    this.onmessage?.({ data: JSON.stringify(frame) });
  };

  readonly frames = (): Record<string, unknown>[] => {
    return this.sent.map((frame) => JSON.parse(frame));
  };
}

class TestClock {
  #now = 0;
  #handle = 0;
  readonly #timers = new Map<number, { readonly at: number; readonly callback: () => void }>();

  now(): number {
    return this.#now;
  }

  setTimeout(callback: () => void, milliseconds: number): number {
    const handle = this.#handle++;
    this.#timers.set(handle, { at: this.#now + milliseconds, callback });
    return handle;
  }

  clearTimeout(handle: unknown): void {
    if (typeof handle === "number") this.#timers.delete(handle);
  }

  advance(milliseconds: number): void {
    const target = this.#now + milliseconds;
    while (true) {
      const due = [...this.#timers.entries()].filter(([, timer]) => timer.at <= target).sort(([leftId, left], [rightId, right]) => left.at - right.at || leftId - rightId)[0];
      if (!due) break;
      const [handle, timer] = due;
      this.#timers.delete(handle);
      this.#now = timer.at;
      timer.callback();
    }
    this.#now = target;
  }
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}
