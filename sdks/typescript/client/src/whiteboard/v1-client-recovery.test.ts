import { ManualClock } from "../test-support/manual-clock";
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
  it("marks only real leadership, keeps its authenticated stamp across reconnect, and preserves relay proof", async () => {
    const clock = new ManualClock();
    const { client, sockets } = recoveryClient(clock, 100);
    const startup = client.startSceneSubscription();
    const view = { x: 10, y: 20, width: 300, height: 200, bring: false };
    try {
      await settle();
      sockets[0]?.open();
      sockets[0]?.receive({ ...welcome(), view_leadership: true });
      await settle();
      const request = sockets[0]?.sent.find((frame) => JSON.parse(frame).type === "request_snapshot");
      sockets[0]?.receive(snapshotPage(JSON.parse(request ?? "{}").request_id));
      await startup;
      client.sendView({ ...view, lead: true });
      const first = JSON.parse(sockets[0]?.sent.at(-1) ?? "{}");
      expect(first).toMatchObject({ lead: true, origin_sequence: 1 });
      const stamp = `123:${"a".repeat(64)}`;
      sockets[0]?.receive({ ...first, lead: undefined, type: "view", participant_id: welcome().participant_id, display_name: "Self", occurred_at: "2026-10-23T00:00:00Z", origin_lead_stamp: stamp, origin_proof: "b".repeat(64) });
      await settle();
      client.sendView(view);
      expect(JSON.parse(sockets[0]?.sent.at(-1) ?? "{}")).toMatchObject({ lead: false, origin_lead_stamp: stamp, origin_sequence: 2 });
      sockets[0]?.close(1006);
      clock.advance(100);
      await settle();
      sockets[1]?.open();
      sockets[1]?.receive({ ...welcome(), view_leadership: true });
      await settle();
      const nextRequest = sockets[1]?.sent.find((frame) => JSON.parse(frame).type === "request_snapshot");
      sockets[1]?.receive(snapshotPage(JSON.parse(nextRequest ?? "{}").request_id));
      await settle();
      client.sendView(view);
      expect(JSON.parse(sockets[1]?.sent.at(-1) ?? "{}")).toMatchObject({ lead: false, origin_lead_stamp: stamp, origin_sequence: 3, origin_connection_id: first.origin_connection_id });
      client.sendView({ ...view, bring: true });
      expect(JSON.parse(sockets[1]?.sent.at(-1) ?? "{}")).toMatchObject({ lead: true, bring: true, origin_sequence: 4 });
      const relay = { ...view, originParticipantId: sceneId, originConnectionId: sceneId, originEpoch: sceneId, originSequence: 100, originLeadStamp: stamp, originProof: "c".repeat(64) };
      client.sendView(relay);
      expect(JSON.parse(sockets[1]?.sent.at(-1) ?? "{}")).toMatchObject({ origin_lead_stamp: stamp, origin_proof: relay.originProof, origin_sequence: 100 });
      expect(JSON.parse(sockets[1]?.sent.at(-1) ?? "{}")).not.toHaveProperty("lead");
    } finally {
      await client.stopSceneSubscription();
    }
  });

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

  it("shares views only after the server accepts view_v1, and steps down for an older server", async () => {
    const clock = new ManualClock();
    const { client, sockets } = recoveryClient(clock);
    const startup = client.startSceneSubscription();
    const view = { x: 1, y: 2, width: 300, height: 200, bring: false };
    const hello = (index: number) => JSON.parse(sockets[index]?.sent[0] ?? "{}").extensions;
    try {
      await settle();
      sockets[0]?.open();
      await settle();
      expect(hello(0)).toEqual([{ name: "presentation_v1" }, { name: "view_v1", origins: true, connection_id: expect.any(String) }]);
      sockets[0]?.close(1008);
      clock.advance(1_000);
      await settle();
      sockets[1]?.open();
      await settle();
      expect(hello(1)).toEqual([{ name: "presentation_v1" }, { name: "view_v1", origins: true }]);
      sockets[1]?.close(1008);
      clock.advance(1_000);
      await settle();
      sockets[2]?.open();
      await settle();
      expect(hello(2)).toEqual([{ name: "presentation_v1" }, { name: "view_v1" }]);
      sockets[2]?.close(1008);
      clock.advance(1_000);
      await acceptSnapshot(sockets, 3);
      await startup;
      expect(hello(3)).toEqual([{ name: "presentation_v1" }]);
      expect(client.supportsViews).toBe(false);
      expect(client.sendView(view)).toBe(false);
    } finally {
      await client.stopSceneSubscription();
    }

    const currentClock = new ManualClock();
    const current = await startedRecoveryClient(currentClock);
    try {
      expect(current.client.supportsViews).toBe(true);
      expect(current.client.sendView(view)).toBe(true);
      expect(JSON.parse(current.sockets[0]?.sent.at(-1) ?? "{}")).toMatchObject({ type: "view", ...view });
      // A dropped connection is not a refusal: views stay available while the client reconnects.
      current.sockets[0]?.close(1006);
      currentClock.advance(1_000);
      await settle();
      current.sockets[1]?.open();
      await settle();
      expect(JSON.parse(current.sockets[1]?.sent[0] ?? "{}").type).toBe("hello");
      expect(current.client.supportsViews).toBe(true);
      expect(current.client.sendView(view)).toBe(true);
    } finally {
      await current.client.stopSceneSubscription();
    }
  });

  it("originates monotonic versions, preserves relayed versions, and interoperates with an older view server", async () => {
    const clock = new ManualClock();
    const { client, sockets } = await startedRecoveryClient(clock);
    const view = { x: 10, y: 20, width: 300, height: 200, bring: false };
    const sent = () => JSON.parse(sockets[0]?.sent.at(-1) ?? "{}");
    try {
      client.sendView(view);
      const first = sent();
      expect(first).toMatchObject({ origin_participant_id: welcome().participant_id, origin_sequence: 1 });
      client.sendView(view);
      expect(sent().origin_sequence).toBe(2); // An intentional return to the same view is still a new local move.
      client.sendView({ ...view, x: 11 });
      expect(sent().origin_sequence).toBe(3);
      client.sendView({ ...view, originParticipantId: sceneId, originSequence: 42 });
      expect(sent()).toMatchObject({ origin_participant_id: sceneId, origin_sequence: 42 });
      client.sendView({ ...view, x: 12 });
      expect(sent().origin_sequence).toBe(4);
    } finally {
      await client.stopSceneSubscription();
    }
    const older = recoveryClient(clock);
    const startup = older.client.startSceneSubscription();
    try {
      await settle();
      older.sockets[0]?.open();
      await settle();
      older.sockets[0]?.close(1008);
      clock.advance(1_000);
      await acceptSnapshot(older.sockets, 1);
      await startup;
      expect(older.client.supportsViews).toBe(true);
      older.client.sendView({ ...view, originParticipantId: sceneId, originSequence: 42 });
      expect(JSON.parse(older.sockets[1]?.sent.at(-1) ?? "{}")).toEqual({ type: "view", ...view, origin_participant_id: sceneId, origin_sequence: 42 });
    } finally {
      await older.client.stopSceneSubscription();
    }
  });

  it("sends Bring as an unversioned command without consuming a view sequence", async () => {
    const { client, sockets } = await startedRecoveryClient(new ManualClock());
    const view = { x: 10, y: 20, width: 300, height: 200, bring: true };
    try {
      client.sendView({ ...view, originParticipantId: sceneId, originSequence: 42 });
      expect(JSON.parse(sockets[0]?.sent.at(-1) ?? "{}")).toEqual({ type: "view", ...view });
      client.sendView({ ...view, bring: false });
      expect(JSON.parse(sockets[0]?.sent.at(-1) ?? "{}").origin_sequence).toBe(1);
    } finally {
      await client.stopSceneSubscription();
    }
  });

  it("starts a fresh transport epoch when the same participant reconnects", async () => {
    const epochs = [];
    for (const _ of [0, 1]) {
      const { client, sockets } = await startedRecoveryClient(new ManualClock());
      try {
        client.sendView({ x: 10, y: 20, width: 300, height: 200, bring: false });
        const frame = JSON.parse(sockets[0]?.sent.at(-1) ?? "{}");
        expect(frame.origin_sequence).toBe(1);
        expect(frame.origin_epoch).toMatch(/^[0-9a-f-]{36}$/);
        epochs.push(frame.origin_epoch);
      } finally {
        await client.stopSceneSubscription();
      }
    }
    expect(epochs[0]).not.toBe(epochs[1]);
  });

  it("renegotiates view support on a later connection after a successful fallback", async () => {
    const clock = new ManualClock();
    const { client, sockets } = recoveryClient(clock);
    const startup = client.startSceneSubscription();
    try {
      for (const index of [0, 1, 2]) {
        await settle();
        sockets[index]?.open();
        await settle();
        sockets[index]?.close(1008);
        clock.advance(1_000);
      }
      await acceptSnapshot(sockets, 3);
      await startup;
      expect(client.supportsViews).toBe(false);
      sockets[3]?.close(1006);
      clock.advance(1_000);
      await acceptSnapshot(sockets, 4);
      expect(client.supportsViews).toBe(true);
      expect(client.sendView({ x: 0, y: 0, width: 100, height: 100, bring: false })).toBe(true);
    } finally {
      await client.stopSceneSubscription();
    }
  });

  it("bounds replay to the 256 most recently active peer views", async () => {
    const { client, sockets } = await startedRecoveryClient(new ManualClock());
    const events: ChalkWhiteboardV1Event[] = [];
    try {
      for (let index = 0; index < 300; index++) {
        sockets[0]?.receive({ type: "view", participant_id: `20000000-0000-4000-8000-${String(index).padStart(12, "0")}`, display_name: "Peer", x: index, y: 0, width: 100, height: 100, bring: false, occurred_at: "2026-10-21T00:00:00Z" });
        await settle();
      }
      const unsubscribe = client.subscribe((event) => events.push(event));
      const views = events.filter((event) => event.type === "view");
      expect(views).toHaveLength(256);
      expect(views[0]).toMatchObject({ x: 44 });
      expect(views.at(-1)).toMatchObject({ x: 299 });
      unsubscribe();
    } finally {
      await client.stopSceneSubscription();
    }
  });

  it("upgrades cached legacy views with their authenticated duplicate without downgrading replay", async () => {
    const { client, sockets } = await startedRecoveryClient(new ManualClock());
    const legacy = { type: "view", participant_id: "20000000-0000-4000-8000-000000000001", display_name: "Omar", x: 10, y: 20, width: 300, height: 200, bring: false, occurred_at: "2026-10-21T04:00:00.000Z", origin_participant_id: sceneId, origin_epoch: sceneId, origin_sequence: 100 };
    const enriched = { ...legacy, origin_connection_id: sceneId, origin_lead_stamp: "1168:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", origin_proof: "a".repeat(64) };
    const replay: ChalkWhiteboardV1Event[] = [];
    let unsubscribe = () => {};
    try {
      sockets[0]?.receive(legacy);
      sockets[0]?.receive(enriched);
      sockets[0]?.receive(legacy);
      sockets[0]?.receive({ ...enriched, origin_sequence: 99, x: 999 });
      await settle();
      unsubscribe = client.subscribe((event) => replay.push(event));
      expect(replay.filter((event) => event.type === "view")).toEqual([expect.objectContaining({ originConnectionId: sceneId, originLeadStamp: "1168:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", originProof: enriched.origin_proof, originSequence: 100, x: 10 })]);
    } finally {
      unsubscribe();
      await client.stopSceneSubscription();
    }
  });

  it("replays the latest ordinary peer view to a later board consumer", async () => {
    const { client, sockets } = await startedRecoveryClient(new ManualClock());
    const events: ChalkWhiteboardV1Event[] = [];
    const view = { type: "view", participant_id: "20000000-0000-4000-8000-000000000001", display_name: "Omar", x: 10, y: 20, width: 300, height: 200, bring: true, occurred_at: "2026-10-21T04:00:00.000Z" };
    let unsubscribe: () => void = () => undefined;
    try {
      sockets[0]?.receive(view);
      await settle();
      unsubscribe = client.subscribe((event) => events.push(event));
      expect(events).toContainEqual(expect.objectContaining({ type: "view", participantId: view.participant_id, x: 10, bring: false }));
    } finally {
      unsubscribe();
      await client.stopSceneSubscription();
    }
  });

  it("sends views immediately after ready consumers subscribe and resubscribe", async () => {
    const { client, sockets } = await startedRecoveryClient(new ManualClock());
    const socket = sockets[0];
    const view = { x: 10, y: 20, width: 300, height: 200, bring: false };
    const events: ChalkWhiteboardV1Event[] = [];
    let unsubscribe: () => void = () => undefined;
    try {
      for (let index = 0; index < 3; index += 1) {
        unsubscribe();
        unsubscribe = client.subscribe((event) => events.push(event));
        expect(events.at(-1)).toMatchObject({ type: "snapshot", sceneId });
        expect(client.sendView({ ...view, x: index })).toBe(true);
        expect(JSON.parse(socket?.sent.at(-1) ?? "{}")).toMatchObject({ type: "view", ...view, x: index });
      }
      expect(socket?.sent.map((wire) => JSON.parse(wire)).filter((frame) => frame.type === "request_snapshot")).toHaveLength(1);
    } finally {
      unsubscribe();
      await client.stopSceneSubscription();
    }
  });

  it("flushes a recovering bring when a snapshot consumer resubscribes on completion", async () => {
    const { client, sockets } = await startedRecoveryClient(new ManualClock());
    const socket = sockets[0];
    const bring = { x: 10, y: 20, width: 300, height: 200, bring: true };
    let unsubscribe: () => void = () => undefined;
    const observe = () => {
      unsubscribe();
      unsubscribe = client.subscribe(() => undefined);
    };
    const stopObserving = client.subscribe((event) => {
      if (event.type === "snapshot") observe();
    });
    try {
      const snapshot = client.requestSnapshot();
      expect(client.sendView(bring)).toBe(true);
      socket?.receive(snapshotPage(socket.requestId()));
      await snapshot;
      expect(socket?.sent.map((wire) => JSON.parse(wire)).filter((frame) => frame.type === "view")).toEqual([expect.objectContaining({ type: "view", ...bring })]);
      const view = { ...bring, x: 40, bring: false };
      expect(client.sendView(view)).toBe(true);
      expect(JSON.parse(socket?.sent.at(-1) ?? "{}")).toMatchObject({ type: "view", ...view });
    } finally {
      unsubscribe();
      stopObserving();
      await client.stopSceneSubscription();
    }
  });

  it.each(["initial", "requested"] as const)("sends an accepted bring after the %s snapshot without replacing it with ordinary views", async (phase) => {
    const { client, sockets, recovery } = await recoveringViewClient(phase);
    const socket = sockets[0];
    const bring = { x: 10, y: 20, width: 300, height: 200, bring: true };
    try {
      expect(client.sendView(bring)).toBe(true);
      expect(client.sendView({ ...bring, x: 99, bring: false })).toBe(true);
      expect(socket?.sent.map((wire) => JSON.parse(wire)).filter((frame) => frame.type === "view")).toEqual([]);
      if (phase === "initial") await acceptSnapshot(sockets);
      else socket?.receive(snapshotPage(socket.requestId()));
      await recovery;
      expect(socket?.sent.map((wire) => JSON.parse(wire)).filter((frame) => frame.type === "view")).toEqual([expect.objectContaining({ type: "view", ...bring })]);
    } finally {
      await client.stopSceneSubscription();
    }
  });

  it.each(["reconnect", "snapshot"] as const)("keeps the latest real leadership move through %s and ignores later idle views", async (phase) => {
    const clock = new ManualClock();
    const { client, sockets } = await startedRecoveryClient(clock);
    try {
      let recovery: Promise<unknown> | undefined;
      if (phase === "reconnect") sockets[0]?.close(1006);
      else {
        recovery = client.requestSnapshot();
        await settle();
      }
      const view = { x: 100, y: 20, width: 300, height: 200, bring: false, lead: true };
      client.sendView(view);
      client.sendView({ ...view, x: 200 });
      client.sendView({ ...view, x: 999, lead: false });
      if (phase === "reconnect") {
        clock.advance(1000);
        await acceptSnapshot(sockets, 1);
      } else sockets[0]?.receive(snapshotPage(sockets[0].requestId()));
      await recovery;
      await settle();
      const socket = sockets.at(-1);
      const views = () => socket?.sent.map((wire) => JSON.parse(wire)).filter((frame) => frame.type === "view");
      expect(views()).toEqual([expect.objectContaining({ x: 200, bring: false })]);
      // Repeated readiness notifications must not flush the intent twice.
      client.sendCursor({ x: 1, y: 2 });
      expect(views()).toHaveLength(1);
    } finally {
      await client.stopSceneSubscription();
    }
  });

  it.each([false, true])("keeps the latest queued Bring across reconnect, plain-view fallback %s", async (fallback) => {
    const clock = new ManualClock();
    const { client, sockets } = await startedRecoveryClient(clock);
    const bring = { x: 10, y: 20, width: 300, height: 200, bring: true };
    try {
      sockets[0]?.close(1006);
      expect(client.sendView(bring)).toBe(true);
      expect(client.sendView({ ...bring, x: 40 })).toBe(true);
      clock.advance(1000);
      let attempt = 1;
      if (fallback) {
        await settle();
        sockets[1]?.open();
        await settle();
        sockets[1]?.close(1008);
        clock.advance(1000);
        attempt = 2;
      }
      await acceptSnapshot(sockets, attempt);
      await settle();
      expect(client.supportsViews).toBe(true);
      const frames = sockets[attempt]?.sent.map((wire) => JSON.parse(wire));
      if (fallback) expect(frames?.find((frame) => frame.type === "hello").extensions).toContainEqual({ name: "view_v1", origins: true });
      expect(frames?.filter((frame) => frame.type === "view")).toEqual([expect.objectContaining({ type: "view", ...bring, x: 40 })]);
    } finally {
      await client.stopSceneSubscription();
    }
  });

  it("does not carry an accepted bring into a restarted subscription", async () => {
    const { client, sockets } = await startedRecoveryClient(new ManualClock());
    const bring = { x: 10, y: 20, width: 300, height: 200, bring: true };
    const snapshot = client.requestSnapshot();
    void snapshot.catch(() => undefined);
    expect(client.sendView(bring)).toBe(true);
    await client.stopSceneSubscription();
    expect(client.sendView(bring)).toBe(false);
    const restart = client.startSceneSubscription();
    try {
      await acceptSnapshot(sockets, 1);
      await restart;
      expect(sockets[1]?.sent.map((wire) => JSON.parse(wire)).filter((frame) => frame.type === "view")).toEqual([]);
    } finally {
      await client.stopSceneSubscription();
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
    const clock = new ManualClock();
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
    const clock = new ManualClock();
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
    const clock = new ManualClock();
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
    const scheduler = new ManualClock();
    const clock = {
      now: () => scheduler.now(),
      setTimeout: (callback: () => void, milliseconds: number) => scheduler.setTimeout(callback, milliseconds),
      clearTimeout: (handle: unknown) => scheduler.clearTimeout(handle),
    };

    // @ts-expect-error JavaScript callers can still pass the v4 three-method clock at runtime.
    expect(() => recoveryClient(scheduler, 100, { clock })).toThrow("whiteboard clock.monotonicNow must use the same timeline as clock.setTimeout");
  });

  it("replaces a silent socket within eight seconds without waiting for its close event", async () => {
    const clock = new ManualClock();
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
    const clock = new ManualClock();
    const { client, sockets } = await startedRecoveryClient(clock);
    clock.advance(6_100);
    sockets[0]?.receive({ type: "pong" });
    await settle();
    clock.advance(1_900);
    expect(sockets[0]?.closeCalls).toHaveLength(1);
    await client.stopSceneSubscription();
  });

  it("accepts normal jitter and one isolated slow sample followed by recovery", async () => {
    const clock = new ManualClock();
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
    const clock = new ManualClock();
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
    const clock = new ManualClock();
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
    const clock = new ManualClock();
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
    const clock = new ManualClock();
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
    await answerProbes(clock, sockets[1], 20);
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
    const { client, sockets } = recoveryClient(new ManualClock(), 100, { clock });
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
    const first = recoveryClient(new ManualClock(), undefined, {
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
      const connected = await startedRecoveryClient(new ManualClock());
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
    const clock = new ManualClock();
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
    const clock = new ManualClock();
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
    const clock = new ManualClock();
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
    const clock = new ManualClock();
    const { client, sockets } = await startedRecoveryClient(clock, 100);
    clock.advance(6_100);
    sockets[0]?.receive({ type: "pong" }); // The first reply is missing; FIFO intentionally reconnects.
    await settle();
    clock.advance(2_000);
    await acceptSnapshot(sockets, 1);
    await answerProbes(clock, sockets[1], 5);
    expect(sockets[1]?.closeCalls).toEqual([]);
    await client.stopSceneSubscription();
  });

  it("ignores unsolicited pongs and resets probes, and can disable replacements", async () => {
    const clock = new ManualClock();
    const { client, sockets } = await startedRecoveryClient(clock, undefined, { watchdog: false });
    sockets[0]?.receive({ type: "pong" });
    await settle();
    clock.advance(60_000);
    expect(sockets[0]?.closeCalls).toEqual([]);
    expect(sockets[0]?.sent.filter((wire) => JSON.parse(wire).type === "ping")).toHaveLength(15);
    await client.stopSceneSubscription();
  });

  it("emits exactly one bounded replacement event", async () => {
    const clock = new ManualClock();
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
    const clock = new ManualClock();
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

function recoveryClient(clock = new ManualClock(), reconnectDelayMs?: number, options: Partial<ChalkWhiteboardV1ClientOptions> = {}) {
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

async function startedRecoveryClient(clock: ManualClock, reconnectDelayMs?: number, options: Partial<ChalkWhiteboardV1ClientOptions> = {}) {
  const result = recoveryClient(clock, reconnectDelayMs, options);
  const startup = result.client.startSceneSubscription();
  await acceptSnapshot(result.sockets);
  await startup;
  return result;
}

async function recoveringViewClient(phase: "initial" | "requested") {
  const result = phase === "initial" ? recoveryClient() : await startedRecoveryClient(new ManualClock());
  const recovery = phase === "initial" ? result.client.startSceneSubscription() : result.client.requestSnapshot();
  return { ...result, recovery };
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

/** Answers each keepalive probe on time, starting with the first one five seconds in. */
async function answerProbes(clock: ManualClock, socket: TestSocket | undefined, probes: number) {
  for (let probe = 0; probe < probes; probe += 1) {
    clock.advance(probe === 0 ? 5_000 : 4_000);
    socket?.receive({ type: "pong" });
    await settle();
  }
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

it("JUDGE: recovery-time real movement is retained as leadership after reconnect", async () => {
  const clock = new ManualClock();
  const { client, sockets } = recoveryClient(clock, 100);
  const startup = client.startSceneSubscription();
  const view = { x: 10, y: 20, width: 300, height: 200, bring: false };
  try {
    await settle();
    sockets[0]?.open();
    sockets[0]?.receive({ ...welcome(), view_leadership: true });
    await settle();
    sockets[0]?.receive(snapshotPage(sockets[0]?.requestId()));
    await startup;
    sockets[0]?.close(1006);
    expect(client.sendView({ ...view, x: 432, lead: true })).toBe(true);
    clock.advance(100);
    await settle();
    sockets[1]?.open();
    sockets[1]?.receive({ ...welcome(), view_leadership: true });
    await settle();
    sockets[1]?.receive(snapshotPage(sockets[1]?.requestId()));
    await settle();
    client.sendView({ ...view, x: 432 });
    const views = sockets[1]?.sent.map((wire) => JSON.parse(wire)).filter((frame) => frame.type === "view");
    expect(views).toContainEqual(expect.objectContaining({ x: 432, lead: true }));
  } finally {
    await client.stopSceneSubscription();
  }
});
