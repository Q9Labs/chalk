import { describe, expect, it, vi } from "vitest";
import { Schema } from "effect";

import { WhiteboardV1ClientFrameSchema } from "../generated/whiteboard-v1";
import type { SyncSocket } from "../sync/types";
import { ChalkWhiteboardV1Client } from "./v1-client";
import type { ChalkWhiteboardV1ClientOptions, ChalkWhiteboardSummary, ChalkWhiteboardV1Event, ChalkWhiteboardV1FileTransport } from "./types";

const sceneId = "10000000-0000-4000-8000-000000000001";
const files: ChalkWhiteboardV1FileTransport = {
  getDownloadUrl: async () => ({ downloadUrl: "https://files.test/download", expiresAt: "2026-08-23T00:00:00.000Z" }),
};

describe("ChalkWhiteboardV1Client recovery summaries", () => {
  it("shares the active snapshot across callers until all pages arrive", async () => {
    const { client, sockets } = recoveryClient();
    const startup = client.startSceneSubscription();
    await settle();
    const socket = sockets[0];
    socket?.open();
    await settle();
    socket?.receive(welcome());
    await settle();
    const first = client.requestSnapshot();
    const second = client.requestSnapshot();
    let completed = false;
    void first.then(
      () => {
        completed = true;
      },
      () => undefined,
    );
    void second.catch(() => undefined);
    try {
      const requests = () => socket?.sent.map((wire) => JSON.parse(wire)).filter((frame) => frame.type === "request_snapshot") ?? [];
      expect(requests()).toHaveLength(1);
      expect(second).toBe(first);
      socket?.receive({ ...snapshotPage(socket.requestId()), page_count: 2 });
      await settle();
      expect(completed).toBe(false);
      expect(client.requestSnapshot()).toBe(first);
      socket?.receive({ ...snapshotPage(socket.requestId()), page: 1, page_count: 2 });
      await Promise.all([startup, first, second]);
      expect(completed).toBe(true);
      const next = client.requestSnapshot();
      expect(next).not.toBe(first);
      expect(requests()).toHaveLength(2);
      socket?.receive(snapshotPage(socket.requestId()));
      await next;
    } finally {
      await client.stopSceneSubscription();
      void startup.catch(() => undefined);
    }
  });

  it("rejects shared snapshot callers together and permits a fresh request", async () => {
    const { client, sockets } = recoveryClient();
    const startup = client.startSceneSubscription();
    await acceptSnapshot(sockets);
    await startup;
    try {
      const first = client.requestSnapshot();
      const second = client.requestSnapshot();
      const failures = Promise.allSettled([first, second]);
      expect(second).toBe(first);
      sockets[0]?.receive({ type: "operation_error", correlation_id: sockets[0]?.requestId(), operation: "request_snapshot", code: "storage_unavailable", recoverable: true, message: "Storage temporarily unavailable." });
      expect((await failures).map((result) => result.status)).toEqual(["rejected", "rejected"]);
      const retry = client.requestSnapshot();
      sockets[0]?.receive(snapshotPage(sockets[0]?.requestId()));
      await retry;
    } finally {
      await client.stopSceneSubscription();
    }
  });

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

describe("whiteboard slow-connection watchdog", () => {
  it("rejects a legacy three-method clock instead of silently disabling recovery", () => {
    const scheduler = new TestClock();
    const clock = {
      now: () => scheduler.now(),
      setTimeout: (callback: () => void, milliseconds: number) => scheduler.setTimeout(callback, milliseconds),
      clearTimeout: (handle: unknown) => scheduler.clearTimeout(handle),
    };

    // @ts-expect-error JavaScript callers can still pass the v4 three-method clock at runtime.
    expect(() => recoveryClient(scheduler, 100, { clock })).toThrow("whiteboard clock.monotonicNow must use the same timeline as clock.setTimeout");
  });

  it("replaces a silent socket within eight seconds without waiting for its close event", async () => {
    const clock = new TestClock();
    const { client, sockets } = await startedRecoveryClient(clock, 100);
    const oldSocket = sockets[0];
    if (!oldSocket) throw new Error("missing socket");
    oldSocket.notifyClose = false;
    clock.advance(7_999);
    expect(oldSocket.closeCalls).toEqual([]);
    clock.advance(1);
    expect(oldSocket.closeCalls).toEqual([{ code: 4000, reason: "whiteboard connection slow" }]);
    clock.advance(100);
    expect(sockets).toHaveLength(2);
    await client.stopSceneSubscription();
  });

  it("does not treat a late pong as the healthy reply to a newer ping", async () => {
    const clock = new TestClock();
    const { client, sockets } = await startedRecoveryClient(clock);
    clock.advance(6_100);
    sockets[0]?.receive({ type: "pong" });
    await settle();
    clock.advance(1_900);
    expect(sockets[0]?.closeCalls).toHaveLength(1);
    await client.stopSceneSubscription();
  });

  it("accepts normal jitter and one isolated slow sample followed by recovery", async () => {
    const clock = new TestClock();
    const { client, sockets } = await startedRecoveryClient(clock);
    for (const rtt of [110, 250, 1_000, 2_100, 250, 110, 1_000]) {
      const previousPings = sockets[0]?.sent.filter((wire) => JSON.parse(wire).type === "ping").length;
      while (sockets[0]?.sent.filter((wire) => JSON.parse(wire).type === "ping").length === previousPings) clock.advance(1);
      clock.advance(rtt);
      sockets[0]?.receive({ type: "pong" });
      await settle();
      // A slow sample overlaps the next ping; answer that probe normally too.
      if (rtt > 2_000) {
        sockets[0]?.receive({ type: "pong" });
        await settle();
      }
    }
    expect(sockets[0]?.closeCalls).toEqual([]);
    await client.stopSceneSubscription();
  });

  it("backs off subsequent replacements even after a new welcome", async () => {
    const clock = new TestClock();
    const { client, sockets } = await startedRecoveryClient(clock, 100);
    clock.advance(8_100);
    await acceptSnapshot(sockets, 1);
    clock.advance(8_899);
    expect(sockets[1]?.closeCalls).toEqual([]);
    clock.advance(1);
    expect(sockets[1]?.closeCalls).toHaveLength(1);
    await client.stopSceneSubscription();
  });

  it("caps recurrent probe back-off at four seconds and resets after healthy replies", async () => {
    const clock = new TestClock();
    const telemetry = vi.fn();
    const { client, sockets } = await startedRecoveryClient(clock, 100, { onWatchdogReplacement: telemetry });
    for (const [index, backoff] of [0, 1_000, 2_000, 4_000, 4_000].entries()) {
      const bound = 8_000 + Math.max(0, backoff - 100);
      clock.advance(bound - 1);
      expect(sockets[index]?.closeCalls).toEqual([]);
      clock.advance(101);
      expect(sockets[index]?.closeCalls).toHaveLength(1);
      await acceptSnapshot(sockets, index + 1);
    }
    expect(telemetry.mock.calls.map(([event]) => event.backoffMs)).toEqual([1_000, 2_000, 4_000, 4_000, 4_000]);
    for (let second = 0; second < 65; second += 1) {
      clock.advance(1_000);
      sockets[5]?.receive({ type: "cursor", participant_id: "20000000-0000-4000-8000-000000000002", display_name: "Peer", x: 1, y: 1, occurred_at: "2026-10-15T00:00:00.000Z" });
      sockets[5]?.receive({ type: "pong" });
      await settle();
    }
    clock.advance(3_000);
    sockets[5]?.receive({ type: "pong" });
    await settle();
    clock.advance(8_100);
    expect(telemetry.mock.calls.at(-1)?.[0].backoffMs).toBe(4_000);
    await acceptSnapshot(sockets, 6);
    for (let sample = 0; sample < 16; sample += 1) {
      clock.advance(sample === 0 ? 7_900 : 4_000);
      sockets[6]?.receive({ type: "pong" });
      await settle();
    }
    clock.advance(8_000);
    expect(telemetry.mock.calls.at(-1)?.[0].backoffMs).toBe(1_000);
    await client.stopSceneSubscription();
  });

  it("ignores extra pongs without shifting future probes", async () => {
    const clock = new TestClock();
    const { client, sockets } = await startedRecoveryClient(clock);
    clock.advance(4_100);
    sockets[0]?.receive({ type: "pong" });
    sockets[0]?.receive({ type: "pong" });
    await settle();
    clock.advance(7_999);
    expect(sockets[0]?.closeCalls).toEqual([]);
    clock.advance(1);
    expect(sockets[0]?.closeCalls).toHaveLength(1);
    await client.stopSceneSubscription();
  });

  it("catches up through the normal reconnect snapshot and ignores the retired socket", async () => {
    const clock = new TestClock();
    const { client, sockets } = recoveryClient(clock, 100);
    const snapshots: ChalkWhiteboardV1Event[] = [];
    client.subscribe((event) => {
      if (event.type === "snapshot") snapshots.push(event);
    });
    const startup = client.startSceneSubscription();
    await acceptSnapshot(sockets);
    await startup;
    const oldSocket = sockets[0];
    if (!oldSocket) throw new Error("missing socket");
    oldSocket.notifyClose = false;
    clock.advance(8_100);
    sockets[1]?.open();
    await settle();
    sockets[1]?.receive(welcome());
    await settle();
    sockets[1]?.receive({ ...snapshotPage(sockets[1]?.requestId()), revision: "2", elements: [{ id: "rectangle", type: "rectangle", version: 1, version_nonce: 1, index: "a0", is_deleted: false, payload: rectangle().payload }] });
    await settle();
    expect(snapshots.at(-1)).toMatchObject({ revision: "2", elements: [{ id: "rectangle" }] });
    oldSocket.receive(snapshotPage("old-request"));
    oldSocket.receive({ type: "pong" });
    oldSocket.onclose?.({ code: 1000 });
    await settle();
    expect(snapshots.at(-1)).toMatchObject({ revision: "2" });
    for (let sample = 0; sample < 20; sample += 1) {
      clock.advance(sample === 0 ? 5_000 : 4_000);
      sockets[1]?.receive({ type: "pong" });
      await settle();
    }
    expect(sockets[1]?.closeCalls).toEqual([]);
    await client.stopSceneSubscription();
  });

  it.each([false, true])("ages probes monotonically across a backward wall-clock correction (injected clock: %s)", async (injected) => {
    vi.useFakeTimers({ toFake: ["Date", "performance", "setTimeout", "clearTimeout"] });
    const clock = injected
      ? {
          now: () => Date.now(),
          monotonicNow: () => performance.now(),
          setTimeout: (callback: () => void, milliseconds: number) => globalThis.setTimeout(callback, milliseconds),
          clearTimeout: (handle: unknown) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
        }
      : undefined;
    const { client, sockets } = recoveryClient(new TestClock(), 100, { clock });
    try {
      const startup = client.startSceneSubscription();
      await acceptSnapshot(sockets);
      await startup;
      vi.advanceTimersByTime(4_000);
      vi.setSystemTime(new Date(Date.now() - 3_600_000));
      vi.advanceTimersByTime(4_000);
      expect(sockets[0]?.closeCalls).toHaveLength(1);
      vi.advanceTimersByTime(100);
      expect(sockets).toHaveLength(2);
    } finally {
      await client.stopSceneSubscription();
      vi.useRealTimers();
    }
  });

  it("removes visibility listeners on restore failure and terminal socket rejection", async () => {
    const document = new EventTarget();
    vi.stubGlobal("document", document);
    const remove = vi.spyOn(document, "removeEventListener");
    const first = recoveryClient(new TestClock(), undefined, {
      pendingStore: {
        load: async () => {
          throw new Error("store unavailable");
        },
        put: async () => {},
        remove: async () => {},
      },
    });
    let second: ChalkWhiteboardV1Client | undefined;
    try {
      await expect(first.client.startSceneSubscription()).rejects.toThrow("Unable to restore");
      expect(remove).toHaveBeenCalledTimes(1);
      const connected = await startedRecoveryClient(new TestClock());
      second = connected.client;
      connected.sockets[0]?.close(1008);
      expect(remove).toHaveBeenCalledTimes(2);
    } finally {
      await first.client.stopSceneSubscription();
      await second?.stopSceneSubscription();
      vi.unstubAllGlobals();
    }
  });

  it("qualifies late timers and pongs after a busy main thread", async () => {
    const clock = new TestClock();
    const { client, sockets } = await startedRecoveryClient(clock);
    clock.advance(4_000);
    clock.stall(2_500);
    sockets[0]?.receive({ type: "pong" });
    await settle();
    clock.advance(4_000);
    sockets[0]?.receive({ type: "pong" });
    await settle();
    expect(sockets[0]?.closeCalls).toEqual([]);
    await client.stopSceneSubscription();
  });

  it("does not replace while hidden or just resumed and removes its visibility listener", async () => {
    const document = new EventTarget();
    const state = { hidden: false };
    Object.defineProperty(document, "hidden", { get: () => state.hidden });
    vi.stubGlobal("document", document);
    const remove = vi.spyOn(document, "removeEventListener");
    const clock = new TestClock();
    const { client, sockets } = recoveryClient(clock);
    try {
      const startup = client.startSceneSubscription();
      await acceptSnapshot(sockets);
      await startup;
      clock.advance(4_000);
      state.hidden = true;
      document.dispatchEvent(new Event("visibilitychange"));
      clock.advance(30_000);
      state.hidden = false;
      document.dispatchEvent(new Event("visibilitychange"));
      clock.advance(3_999);
      expect(sockets[0]?.closeCalls).toEqual([]);
      await client.stopSceneSubscription();
      expect(remove).toHaveBeenCalledWith("visibilitychange", expect.any(Function));
    } finally {
      await client.stopSceneSubscription();
      vi.unstubAllGlobals();
    }
  });

  it("counts snapshot pages as progress even with pongs queued behind replay", async () => {
    const clock = new TestClock();
    const { client, sockets } = recoveryClient(clock);
    const startup = client.startSceneSubscription();
    await settle();
    sockets[0]?.open();
    await settle();
    sockets[0]?.receive(welcome());
    await settle();
    for (let page = 0; page < 20; page += 1) {
      clock.advance(1_000);
      sockets[0]?.receive({ ...snapshotPage(sockets[0]?.requestId()), page, page_count: 20 });
      await settle();
    }
    await startup;
    expect(sockets[0]?.closeCalls).toEqual([]);
    await client.stopSceneSubscription();
  });

  it("replaces after a dropped pong, then matches the fresh connection normally", async () => {
    const clock = new TestClock();
    const { client, sockets } = await startedRecoveryClient(clock, 100);
    clock.advance(6_100);
    sockets[0]?.receive({ type: "pong" }); // The first reply is missing; FIFO intentionally reconnects.
    await settle();
    clock.advance(2_000);
    await acceptSnapshot(sockets, 1);
    for (let index = 0; index < 5; index += 1) {
      clock.advance(index === 0 ? 5_000 : 4_000);
      sockets[1]?.receive({ type: "pong" });
      await settle();
    }
    expect(sockets[1]?.closeCalls).toEqual([]);
    await client.stopSceneSubscription();
  });

  it("ignores unsolicited pongs and resets probes, and can disable replacements", async () => {
    const clock = new TestClock();
    const { client, sockets } = await startedRecoveryClient(clock, undefined, { watchdog: false });
    sockets[0]?.receive({ type: "pong" });
    await settle();
    clock.advance(60_000);
    expect(sockets[0]?.closeCalls).toEqual([]);
    expect(sockets[0]?.sent.filter((wire) => JSON.parse(wire).type === "ping")).toHaveLength(15);
    await client.stopSceneSubscription();
  });

  it("emits exactly one bounded replacement event", async () => {
    const clock = new TestClock();
    const telemetry = vi.fn();
    const { client, sockets } = await startedRecoveryClient(clock, 100, { onWatchdogReplacement: telemetry });
    clock.advance(6_200);
    sockets[0]?.receive({ type: "pong" });
    await settle();
    clock.advance(1_800);
    expect(telemetry).toHaveBeenCalledExactlyOnceWith({ reason: "slow_heartbeat", roundTripsMs: [2_200], outstandingAgesMs: [2_000], backoffMs: 1_000 });
    await client.stopSceneSubscription();
  });

  it("stops a slow socket immediately without waiting for the close handshake or reconnecting", async () => {
    const clock = new TestClock();
    const { client, sockets } = await startedRecoveryClient(clock);
    const socket = sockets[0];
    if (!socket) throw new Error("missing socket");
    socket.notifyClose = false;
    clock.advance(4_100);
    await client.stopSceneSubscription();
    expect(socket.closeCalls).toEqual([{ code: 1000, reason: "whiteboard subscription stopped" }]);
    clock.advance(60_000);
    expect(sockets).toHaveLength(1);
  });
});

function rectangle() {
  return { id: "rectangle", type: "rectangle", version: 1, versionNonce: 1, index: "a0", isDeleted: false, payload: { x: 10, y: 10, width: 100, height: 100 } };
}

function recoveryClient(clock = new TestClock(), reconnectDelayMs?: number, options: Partial<ChalkWhiteboardV1ClientOptions> = {}) {
  const sockets: TestSocket[] = [];
  const client = new ChalkWhiteboardV1Client({
    url: "ws://sync.test/v1/whiteboard",
    token: async () => "token",
    files,
    clock,
    reconnectDelayMs,
    ...options,
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

async function startedRecoveryClient(clock: TestClock, reconnectDelayMs?: number, options: Partial<ChalkWhiteboardV1ClientOptions> = {}) {
  const result = recoveryClient(clock, reconnectDelayMs, options);
  const startup = result.client.startSceneSubscription();
  await acceptSnapshot(result.sockets);
  await startup;
  return result;
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
  for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();
}

class TestSocket implements SyncSocket {
  onopen: (() => void) | null = null;
  onmessage: ((event: { readonly data: unknown }) => void) | null = null;
  onclose: ((event: { readonly code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  notifyClose = true;
  readonly sent: string[] = [];
  readonly closeCalls: { readonly code: number; readonly reason?: string }[] = [];

  send(data: string): void {
    this.sent.push(data);
  }

  close(code = 1000, reason?: string): void {
    this.closeCalls.push({ code, reason });
    if (this.notifyClose) this.onclose?.({ code });
  }

  open(): void {
    this.onopen?.();
  }

  receive(frame: Record<string, unknown>): void {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }

  requestId(): string | undefined {
    const frame = this.sent.map((value) => Schema.decodeUnknownSync(WhiteboardV1ClientFrameSchema)(JSON.parse(value))).findLast((value) => value.type === "request_snapshot");
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

  monotonicNow(): number {
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

  stall(milliseconds: number): void {
    this.#now += milliseconds;
    const due = [...this.#timers.entries()].filter(([, timer]) => timer.at <= this.#now);
    for (const [handle, timer] of due) {
      this.#timers.delete(handle);
      timer.callback();
    }
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
