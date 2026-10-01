import { describe, expect, it } from "vitest";
import { Schema } from "effect";

import { WhiteboardV1ClientFrameSchema } from "../generated/whiteboard-v1";
import type { SyncSocket } from "../sync/types";
import { ChalkWhiteboardV1Client } from "./v1-client";
import type { ChalkWhiteboardSummary, ChalkWhiteboardV1FileTransport } from "./types";

const sceneId = "10000000-0000-4000-8000-000000000001";
const files: ChalkWhiteboardV1FileTransport = {
  initiateUpload: async () => ({ uploadId: "upload-1", method: "PUT", uploadUrl: "https://files.test/upload", headers: {}, expiresAt: "2026-08-23T00:00:00.000Z" }),
  finalizeUpload: async () => undefined,
  getDownloadUrl: async () => ({ downloadUrl: "https://files.test/download", expiresAt: "2026-08-23T00:00:00.000Z" }),
};

describe("ChalkWhiteboardV1Client recovery summaries", () => {
  it("holds cursors until the recovery snapshot is acknowledged", async () => {
    const clock = new TestClock();
    const { client, sockets } = recoveryClient(clock, 100);
    const startup = client.startSceneSubscription();
    await acceptSnapshot(sockets);
    await startup;
    try {
      sockets[0]?.close(1012);
      clock.advance(100);
      sockets[1]?.open();
      await settle();
      sockets[1]?.receive(welcome());
      await settle();
      client.sendCursor({ x: 10, y: 20 });
      const frames = () => sockets[1]?.sent.map((wire) => Schema.decodeUnknownSync(WhiteboardV1ClientFrameSchema)(JSON.parse(wire))) ?? [];
      expect(frames().filter((frame) => frame.type === "cursor")).toHaveLength(0);
      sockets[1]?.receive(snapshotPage(sockets[1]?.requestId()));
      await settle();
      clock.advance(100);
      client.sendCursor({ x: 30, y: 40 });
      expect(frames().filter((frame) => frame.type === "cursor")).toHaveLength(1);
    } finally {
      await client.stopSceneSubscription();
    }
  });

  it("sends edits held behind a snapshot when that snapshot is rejected", async () => {
    const { client, sockets } = recoveryClient();
    const startup = client.startSceneSubscription();
    await acceptSnapshot(sockets);
    await startup;
    const snapshot = client.requestSnapshot();
    void snapshot.catch(() => undefined);
    const drawing = client.submitUpdate({ sceneId, syncAll: false, elements: [rectangle()] });
    void drawing.catch(() => undefined);
    try {
      await settle();
      const requests = sockets[0]?.sent.map((wire) => JSON.parse(wire)).filter((frame) => frame.type === "request_snapshot") ?? [];
      sockets[0]?.receive({ type: "operation_error", correlation_id: requests.at(-1)?.request_id, operation: "request_snapshot", code: "storage_unavailable", recoverable: true, message: "Storage temporarily unavailable." });
      await expect(snapshot).rejects.toMatchObject({ code: "storage_unavailable", recoverable: true });
      await settle();
      const sent = sockets[0]?.sent.map((wire) => JSON.parse(wire)) ?? [];
      expect(sent.some((frame) => frame.type === "submit_update")).toBe(true);
    } finally {
      await client.stopSceneSubscription();
    }
  });

  it("retains and replays a rectangle drawn during socket recovery before replacing the snapshot", async () => {
    const clock = new TestClock();
    const { client, sockets } = recoveryClient(clock, 100);
    const startup = client.startSceneSubscription();
    await acceptSnapshot(sockets);
    await startup;
    sockets[0]?.close(1012);
    const drawing = client.submitUpdate({ sceneId, syncAll: false, elements: [rectangle()] });
    await settle();
    clock.advance(100);
    sockets[1]?.open();
    await settle();
    sockets[1]?.receive(welcome());
    await settle();
    const sent = sockets[1]?.sent.map((wire) => Schema.decodeUnknownSync(WhiteboardV1ClientFrameSchema)(JSON.parse(wire))) ?? [];
    const update = sent.find((frame) => frame.type === "submit_update");
    expect(update).toMatchObject({ type: "submit_update", elements: [{ id: "rectangle" }] });
    expect(sent.some((frame) => frame.type === "request_snapshot")).toBe(false);
    if (!update || update.type !== "submit_update") throw new Error("missing replay");
    sockets[1]?.receive({ type: "commit", outcome: "committed", operation_id: update.operation_id, scene_id: sceneId, revision: "2" });
    await expect(drawing).resolves.toMatchObject({ revision: "2" });
    expect(sockets[1]?.requestId()).toBeDefined();
    await client.stopSceneSubscription();
  });

  it("uses the application close code when token authentication fails", async () => {
    const socket = new TestSocket();
    const client = new ChalkWhiteboardV1Client({
      url: "ws://sync.test/v1/whiteboard",
      token: async () => Promise.reject(new Error("token unavailable")),
      files,
      webSocket: { connect: () => socket },
    });

    const startup = client.startSceneSubscription();
    void startup.catch(() => undefined);
    await settle();
    socket.open();
    await settle();

    expect(socket.closeCalls).toEqual([{ code: 4000, reason: "whiteboard authentication failed" }]);
    await client.stopSceneSubscription();
  });

  it("uses capped exponential reconnect backoff until a welcome is live", async () => {
    const clock = new TestClock();
    const { client, sockets } = recoveryClient(clock, 100);

    const startup = client.startSceneSubscription();
    void startup.catch(() => undefined);
    await settle();
    sockets[0]?.close(1012);
    clock.advance(99);
    expect(sockets).toHaveLength(1);
    clock.advance(1);
    expect(sockets).toHaveLength(2);
    sockets[1]?.close(1012);
    clock.advance(199);
    expect(sockets).toHaveLength(2);
    clock.advance(1);
    expect(sockets).toHaveLength(3);

    await client.stopSceneSubscription();
  });

  it("publishes terminal failure after ready and can be started again without duplicate sockets", async () => {
    const { client, sockets } = recoveryClient();
    const summaries: ChalkWhiteboardSummary["status"][] = [];
    const unsubscribeSummary = client.subscribeSummary((summary) => summaries.push(summary.status));

    const startup = client.startSceneSubscription();
    await acceptSnapshot(sockets);
    await expect(startup).resolves.toBeUndefined();
    expect(summaries.at(-1)).toBe("ready");

    sockets[0]?.close(1009);
    expect(summaries.slice(-2)).toEqual(["recovering", "failed"]);

    const retry = client.startSceneSubscription();
    await acceptSnapshot(sockets, 1);
    await expect(retry).resolves.toBeUndefined();
    expect(sockets).toHaveLength(2);
    expect(summaries.at(-1)).toBe("ready");

    unsubscribeSummary();
    await client.stopSceneSubscription();
  });
});

function rectangle() {
  return { id: "rectangle", type: "rectangle", version: 1, versionNonce: 1, index: "a0", isDeleted: false, payload: { x: 10, y: 10, width: 100, height: 100 } };
}

function recoveryClient(clock = new TestClock(), reconnectDelayMs?: number) {
  const sockets: TestSocket[] = [];
  const client = new ChalkWhiteboardV1Client({
    url: "ws://sync.test/v1/whiteboard",
    token: async () => "token",
    files,
    clock,
    reconnectDelayMs,
    webSocket: {
      connect: () => {
        const socket = new TestSocket();
        sockets.push(socket);
        return socket;
      },
    },
  });
  return { client, sockets };
}

async function acceptSnapshot(sockets: readonly TestSocket[], index = 0) {
  await settle();
  const socket = sockets[index];
  socket?.open();
  await settle();
  socket?.receive(welcome());
  await settle();
  socket?.receive(snapshotPage(socket.requestId()));
}

function welcome(): Record<string, unknown> {
  return {
    type: "welcome",
    protocol: "whiteboard-v1",
    participant_id: "20000000-0000-4000-8000-000000000001",
    participant_generation: 1,
    capabilities: ["drawWhiteboard"],
    participant_capabilities: ["drawWhiteboard"],
    scene_id: sceneId,
    revision: "1",
    can_draw: true,
    presenting: false,
  };
}

function snapshotPage(requestId: string | undefined): Record<string, unknown> {
  return {
    type: "snapshot_page",
    request_id: requestId ?? "request-0000000001",
    scene_id: sceneId,
    revision: "1",
    page: 0,
    page_count: 1,
    elements: [],
    app_state: null,
  };
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

class TestSocket implements SyncSocket {
  onopen: (() => void) | null = null;
  onmessage: ((event: { readonly data: unknown }) => void) | null = null;
  onclose: ((event: { readonly code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  readonly sent: string[] = [];
  readonly closeCalls: { readonly code: number; readonly reason?: string }[] = [];

  send(data: string): void {
    this.sent.push(data);
  }

  close(code = 1000, reason?: string): void {
    this.closeCalls.push({ code, reason });
    this.onclose?.({ code });
  }

  open(): void {
    this.onopen?.();
  }

  receive(frame: Record<string, unknown>): void {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }

  requestId(): string | undefined {
    const frame = this.sent.map((value) => Schema.decodeUnknownSync(WhiteboardV1ClientFrameSchema)(JSON.parse(value))).find((value) => value.type === "request_snapshot");
    return frame?.request_id;
  }
}

class TestClock {
  #now = 0;
  #nextHandle = 0;
  readonly #timers = new Map<number, { readonly at: number; readonly callback: () => void }>();

  now(): number {
    return this.#now;
  }

  setTimeout(callback: () => void, milliseconds: number): number {
    const handle = this.#nextHandle++;
    this.#timers.set(handle, { at: this.#now + milliseconds, callback });
    return handle;
  }

  clearTimeout(handle: unknown): void {
    if (typeof handle === "number") this.#timers.delete(handle);
  }

  advance(milliseconds: number): void {
    const target = this.#now + milliseconds;
    while (true) {
      const due = [...this.#timers.entries()].filter(([, timer]) => timer.at <= target).sort(([leftHandle, left], [rightHandle, right]) => left.at - right.at || leftHandle - rightHandle)[0];
      if (!due) break;
      const [handle, timer] = due;
      this.#timers.delete(handle);
      this.#now = timer.at;
      timer.callback();
    }
    this.#now = target;
  }
}
