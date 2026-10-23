import { describe, expect, it, vi } from "vitest";
import { Schema } from "effect";

import { WhiteboardV1ClientFrameSchema } from "../generated/whiteboard-v1";
import type { SyncSocket } from "../sync/types";
import { TestClock } from "../test-support/clock.test.helpers";
import { ChalkWhiteboardV1Client } from "./v1-client";
import { InMemoryChalkWhiteboardV1PendingOperationStore } from "./v1-persistence";
import { ManualClock } from "../../tests/helpers/manual-clock";
import type { ChalkWhiteboardDrawPolicy, ChalkWhiteboardV1ClientOptions, ChalkWhiteboardSummary, ChalkWhiteboardV1Event, ChalkWhiteboardV1FileTransport, ChalkWhiteboardV1PendingOperation } from "./types";

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
      expect(hello(0)).toEqual([{ name: "presentation_v1" }, { name: "view_v1", origins: true, owner: true }, { name: "draw_policy_v1" }]);
      sockets[0]?.close(1009);
      clock.advance(1_000);
      await settle();
      sockets[1]?.open();
      await settle();
      expect(hello(1)).toEqual([{ name: "presentation_v1" }, { name: "view_v1", origins: true }]);
      sockets[1]?.close(1009);
      clock.advance(1_000);
      await settle();
      sockets[2]?.open();
      await settle();
      expect(hello(2)).toEqual([{ name: "presentation_v1" }, { name: "view_v1" }]);
      sockets[2]?.close(1009);
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
      for (const index of [0, 1]) {
        await settle();
        older.sockets[index]?.open();
        await settle();
        older.sockets[index]?.close(1009);
        clock.advance(1_000);
      }
      await acceptSnapshot(older.sockets, 2);
      await startup;
      expect(older.client.supportsViews).toBe(true);
      older.client.sendView({ ...view, originParticipantId: sceneId, originSequence: 42 });
      expect(JSON.parse(older.sockets[2]?.sent.at(-1) ?? "{}")).toEqual({ type: "view", ...view });
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
        sockets[index]?.close(1009);
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
      expect(sentFrames(socket, "view")).toEqual([expect.objectContaining({ type: "view", ...bring })]);
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
      expect(sentFrames(socket, "view")).toEqual([]);
      if (phase === "initial") await acceptSnapshot(sockets);
      else socket?.receive(snapshotPage(socket.requestId()));
      await recovery;
      expect(sentFrames(socket, "view")).toEqual([expect.objectContaining({ type: "view", ...bring })]);
    } finally {
      await client.stopSceneSubscription();
    }
  });

  it("keeps only the latest accepted bring across a reconnect", async () => {
    const { clock, client, sockets, bring } = await bringWhileReconnecting();
    try {
      expect(client.sendView({ ...bring, x: 40 })).toBe(true);
      clock.advance(1_000);
      if (fallback) {
        await settle();
        sockets[1]?.open();
        await settle();
        sockets[1]?.close(1008);
        clock.advance(1_000);
      }
      const index = fallback ? 2 : 1;
      await acceptSnapshot(sockets, index);
      await settle();
      expect(sentFrames(sockets[1], "view")).toEqual([expect.objectContaining({ type: "view", ...bring, x: 40 })]);
    } finally {
      await client.stopSceneSubscription();
    }
  });

  it("preserves a queued Bring when origin negotiation falls back to plain views", async () => {
    const { clock, client, sockets, bring } = await bringWhileReconnecting();
    try {
      for (const index of [1, 2]) {
        clock.advance(1_000);
        await settle();
        sockets[index]?.open();
        await settle();
        sockets[index]?.close(1009);
      }
      clock.advance(1_000);
      await acceptSnapshot(sockets, 3);
      expect(client.supportsViews).toBe(true);
      expect(helloExtensions(sockets[3])).toContainEqual({ name: "view_v1" });
      expect(sentFrames(sockets[3], "view")).toEqual([expect.objectContaining({ type: "view", ...bring })]);
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
      expect(sentFrames(sockets[1], "view")).toEqual([]);
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

describe("ChalkWhiteboardV1Client drawing policy", () => {
  it("takes its drawing permission and the host's choices from draw_access, which Sync computes", async () => {
    const summaries: ChalkWhiteboardSummary[] = [];
    const { client, sockets } = await startedRecoveryClient(new ManualClock(), undefined, { onSummary: (summary) => summaries.push(summary) });
    const picked = "20000000-0000-4000-8000-000000000002";
    try {
      expect(client.supportsViews).toBe(true);
      expect(summaries.at(-1)).toMatchObject({ canDraw: true, drawPolicy: null });
      await expect(client.setDrawPolicy("hosts")).rejects.toMatchObject({ operation: "set_draw_policy", code: "unavailable" });

      sockets[0]?.receive({ type: "draw_access", policy: "picked", can_draw: false, capabilities: ["drawWhiteboard", "manageWhiteboard"], grants: [{ participant_id: picked, can_draw: true }] });
      await settle();
      expect(summaries.at(-1)).toMatchObject({ status: "ready", canDraw: false, canClear: true, drawPolicy: "picked", drawPermissions: [{ participantId: picked, canDraw: true }] });
      expect(() => client.submitUpdate({ sceneId, syncAll: false, elements: [] })).toThrow(expect.objectContaining({ code: "permission_denied" }));

      // A picked person whose role cannot draw still draws, because the permission is Sync's, not the role's.
      sockets[0]?.receive({ type: "draw_access", policy: "picked", can_draw: true, capabilities: [], grants: [] });
      await settle();
      void client.submitUpdate({ sceneId, syncAll: false, elements: [] }).catch(() => undefined);
      await settle();
      expect(sockets[0]?.sent.map((wire) => JSON.parse(wire).type)).toContain("submit_update");
    } finally {
      await client.stopSceneSubscription();
    }
  });

  it("sends a host's policy change as a receipted operation", async () => {
    const { client, sockets } = await hostClient();
    try {
      const change = client.setDrawPolicy("hosts");
      await settle();
      const [frame] = sentFrames(sockets[0], "set_draw_policy");
      expect(frame).toMatchObject({ type: "set_draw_policy", policy: "hosts" });
      commit(sockets[0], frame.operation_id, "1");
      await expect(change).resolves.toBeUndefined();
    } finally {
      await client.stopSceneSubscription();
    }
  });

  it("sends a host's access changes one at a time in order, so a retried earlier change can't land after a later one", async () => {
    const clock = new ManualClock();
    const { client, sockets } = await hostClient(clock);
    const person = "20000000-0000-4000-8000-000000000002";
    const sent = () => sentFrames(sockets[0], "set_draw_policy", "set_draw_permission");
    try {
      const changes = [client.setDrawPolicy("picked"), client.setDrawPermission(person, false), client.setDrawPolicy("everyone"), client.setDrawPermission(person, true)];
      await settle();
      expect(sent().map((frame) => frame.policy ?? frame.can_draw)).toEqual(["picked"]);

      const [picked] = sent();
      sockets[0]?.receive({ type: "operation_error", correlation_id: picked.operation_id, operation: "set_draw_policy", code: "storage_unavailable", recoverable: true, message: "Storage temporarily unavailable." });
      await settle();
      clock.advance(5_000);
      await settle();
      for (let index = 0; index < 4; index += 1) {
        commit(sockets[0], sent().at(-1).operation_id, "1");
        await settle();
      }

      expect(sent().map((frame) => frame.policy ?? frame.can_draw)).toEqual(["picked", "picked", false, "everyone", true]);
      await expect(Promise.all(changes)).resolves.toEqual([undefined, undefined, undefined, undefined]);
    } finally {
      await client.stopSceneSubscription();
    }
  });

  it("sends access changes in the order they were made even when a later save finishes first", async () => {
    const { pendingStore, saves } = heldPolicyStore("before");
    const { client, sockets } = await hostClient(new ManualClock(), { pendingStore }, "picked");
    const sent = () => sentFrames(sockets[0], "set_draw_policy");
    try {
      const changes = [client.setDrawPolicy("everyone"), client.setDrawPolicy("hosts"), client.setDrawPolicy("picked")];
      void changes[1]?.catch(() => undefined);
      await settle();
      saves[2]?.resolve();
      await settle();
      saves[1]?.reject(new Error("disk full"));
      await settle();
      expect(sent()).toEqual([]);

      saves[0]?.resolve();
      await settle();
      expect(sent().map((frame) => frame.policy)).toEqual(["everyone"]);
      commit(sockets[0], sent()[0].operation_id, "1");
      await settle();
      expect(sent().map((frame) => frame.policy)).toEqual(["everyone", "picked"]);
      commit(sockets[0], sent()[1].operation_id, "2");
      await expect(changes[0]).resolves.toBeUndefined();
      await expect(changes[1]).rejects.toMatchObject({ operation: "set_draw_policy", code: "unavailable" });
      await expect(changes[2]).resolves.toBeUndefined();
    } finally {
      for (const save of saves) save.resolve();
      await client.stopSceneSubscription();
    }
  });

  it("sends a held access change when the save of the one before it fails", async () => {
    const { pendingStore, saves } = heldPolicyStore("after");
    const { client, sockets } = await hostClient(new ManualClock(), { pendingStore }, "picked");
    const sent = () => sentFrames(sockets[0], "set_draw_policy");
    try {
      const first = client.setDrawPolicy("everyone");
      void first.catch(() => undefined);
      const second = client.setDrawPolicy("hosts");
      await settle();
      saves[1]?.resolve();
      await settle();
      expect(sent()).toEqual([]);

      saves[0]?.reject(new Error("disk full"));
      await expect(first).rejects.toMatchObject({ operation: "set_draw_policy", code: "unavailable" });
      await settle();
      expect(sent().map((frame) => frame.policy)).toEqual(["hosts"]);
      commit(sockets[0], sent()[0].operation_id, "1");
      await expect(second).resolves.toBeUndefined();
    } finally {
      for (const save of saves) save.resolve();
      await client.stopSceneSubscription();
    }
  });

  it("doesn't resend an access change waiting on its receipt when a later save fails", async () => {
    const { client, sockets, saves } = await twoQueuedPolicyChanges();
    try {
      saves[1]?.reject(new Error("disk full"));
      await settle();
      expect(sentPolicies(sockets[0])).toEqual(["hosts"]);
    } finally {
      for (const save of saves) save.resolve();
      await client.stopSceneSubscription();
    }
  });

  // Each order sends the first change once per connection until its receipt or failure decides it, and the second only after that.
  it.each<{ order: string; steps: (queued: Awaited<ReturnType<typeof twoQueuedPolicyChanges>>) => Promise<void>; sent: string[][]; second: "resolves" | "rejects" }>([
    {
      order: "the receipt comes first",
      steps: async ({ sockets, saves, first }) => {
        commit(sockets[0], first(), "1");
        await settle();
        saves[1]?.resolve();
        await settle();
      },
      sent: [["hosts", "picked"]],
      second: "resolves",
    },
    {
      order: "the later save fails first",
      steps: async ({ sockets, saves, first }) => {
        saves[1]?.reject(new Error("disk full"));
        await settle();
        commit(sockets[0], first(), "1");
        await settle();
      },
      sent: [["hosts"]],
      second: "rejects",
    },
    {
      order: "the first change times out on Sync and is retried",
      steps: async ({ sockets, saves, first, clock }) => {
        sockets[0]?.receive({ type: "operation_error", correlation_id: first(), operation: "set_draw_policy", code: "storage_unavailable", recoverable: true, message: "Storage timed out." });
        saves[1]?.resolve();
        await settle();
        expect(sentPolicies(sockets[0])).toEqual(["hosts"]);
        clock.advance(5_000);
        await settle();
        commit(sockets[0], first(), "1");
        await settle();
      },
      sent: [["hosts", "hosts", "picked"]],
      second: "resolves",
    },
    {
      order: "the connection drops before the receipt",
      steps: async ({ sockets, saves, first, clock }) => {
        sockets[0]?.close(1006);
        await redial(clock, sockets, 1);
        sockets[1]?.receive(welcome());
        saves[1]?.resolve();
        await settle();
        expect(sentPolicies(sockets[1])).toEqual(["hosts"]);
        commit(sockets[1], first(), "1");
        await settle();
        sockets[1]?.receive(snapshotPage(sockets[1]?.requestId()));
        await settle();
      },
      sent: [["hosts"], ["hosts", "picked"]],
      second: "resolves",
    },
  ])("sends each access change once until it is decided when $order", async ({ steps, sent, second }) => {
    const queued = await twoQueuedPolicyChanges();
    try {
      await steps(queued);
      expect(queued.sockets.slice(0, sent.length).map(sentPolicies)).toEqual(sent);
      await expect(queued.changes[0]).resolves.toBeUndefined();
      if (second === "resolves") {
        commit(queued.sockets[sent.length - 1], sentFrames(queued.sockets[sent.length - 1], "set_draw_policy").at(-1).operation_id, "2");
        await expect(queued.changes[1]).resolves.toBeUndefined();
      } else {
        await expect(queued.changes[1]).rejects.toMatchObject({ operation: "set_draw_policy", code: "unavailable" });
      }
    } finally {
      for (const save of queued.saves) save.resolve();
      await queued.client.stopSceneSubscription();
    }
  });

  it("keeps a saved first change ahead when a later save fails in the same turn as it", async () => {
    const { pendingStore, saves } = heldPolicyStore("before");
    const { client, sockets } = await hostClient(new ManualClock(), { pendingStore });
    const changes = [client.setDrawPolicy("hosts"), client.setDrawPolicy("picked"), client.setDrawPolicy("everyone")];
    for (const change of changes) void change.catch(() => undefined);
    try {
      await settle();
      saves[2]?.resolve();
      await settle();
      expect(sentPolicies(sockets[0])).toEqual([]);
      saves[0]?.resolve();
      saves[1]?.reject(new Error("disk full"));
      await settle();
      expect(sentPolicies(sockets[0])).toEqual(["hosts"]);
      commit(sockets[0], sentFrames(sockets[0], "set_draw_policy").at(-1).operation_id, "1");
      await settle();
      expect(sentPolicies(sockets[0])).toEqual(["hosts", "everyone"]);
      commit(sockets[0], sentFrames(sockets[0], "set_draw_policy").at(-1).operation_id, "2");
      await expect(changes[0]).resolves.toBeUndefined();
      await expect(changes[1]).rejects.toMatchObject({ code: "unavailable" });
      await expect(changes[2]).resolves.toBeUndefined();
      expect(await pendingStore.load()).toEqual([]);
    } finally {
      for (const save of saves) save.resolve();
      await client.stopSceneSubscription();
    }
  });

  it("ignores a receipt from the last connection for a change that was already decided", async () => {
    const clock = new ManualClock();
    const { client, sockets } = await hostClient(clock);
    try {
      const changes = [client.setDrawPolicy("hosts"), client.setDrawPolicy("picked")];
      await settle();
      const first = sentFrames(sockets[0], "set_draw_policy")[0].operation_id;
      commit(sockets[0], first, "1");
      await changes[0];
      await reconnect(clock, sockets);
      expect(sentPolicies(sockets[1])).toEqual(["picked"]);
      commit(sockets[1], first, "1");
      await settle();
      expect(sentPolicies(sockets[1])).toEqual(["picked"]);
      commit(sockets[1], sentFrames(sockets[1], "set_draw_policy")[0].operation_id, "2");
      await expect(changes[1]).resolves.toBeUndefined();
    } finally {
      await client.stopSceneSubscription();
    }
  });

  it("sends the next access change exactly once when the sent one fails for good while the next is saving", async () => {
    const queued = await twoQueuedPolicyChanges();
    try {
      queued.sockets[0]?.receive({ type: "operation_error", correlation_id: queued.first(), operation: "set_draw_policy", code: "permission_denied", recoverable: false, message: "Permission denied." });
      await settle();
      expect(sentPolicies(queued.sockets[0])).toEqual(["hosts"]);
      queued.saves[1]?.resolve();
      await settle();
      expect(sentPolicies(queued.sockets[0])).toEqual(["hosts", "picked"]);
      commit(queued.sockets[0], sentFrames(queued.sockets[0], "set_draw_policy").at(-1).operation_id, "2");
      await expect(queued.changes[0]).rejects.toMatchObject({ code: "permission_denied" });
      await expect(queued.changes[1]).resolves.toBeUndefined();
    } finally {
      for (const save of queued.saves) save.resolve();
      await queued.client.stopSceneSubscription();
    }
  });

  // Every order the three saves can finish in, cut into turns every way, with every save outcome and a receipt, a
  // final failure or nothing for the sent change after each turn: 6 orders x 8 outcomes x 48 paths through the turn
  // groupings and decisions, so 2,304 cases per store.
  it.each(SAVE_ORDERS.flatMap((order) => (["before", "after"] as const).map((write) => ({ order, write }))))("sends saved access changes once each, in the order they were made, when saves finish in order $order with a store that writes $write the wait", async ({ order, write }) => {
    for (const turns of turnsOf(order)) {
      for (const saved of outcomesOf(3)) {
        for (const decisions of decisionsOf(turns.length)) await expectCreationOrder({ write, turns, saved, decisions });
      }
    }
  });

  it("keeps creation order on reconnect when the first change is still saving and a later one is saved", async () => {
    const clock = new ManualClock();
    const { pendingStore, saves } = heldPolicyStore("before");
    const { client, sockets } = await hostClient(clock, { pendingStore });
    const changes = [client.setDrawPolicy("hosts"), client.setDrawPolicy("picked")];
    try {
      await settle();
      saves[1]?.resolve();
      await settle();
      await reconnect(clock, sockets);
      expect(sentPolicies(sockets[1])).toEqual([]);
      sockets[1]?.receive(snapshotPage(sockets[1]?.requestId()));
      saves[0]?.resolve();
      await settle();
      expect(sentPolicies(sockets[1])).toEqual(["hosts"]);
      await commitFirst(sockets[1], "2");
      expect(sentPolicies(sockets[1])).toEqual(["hosts", "picked"]);
      commit(sockets[1], sentFrames(sockets[1], "set_draw_policy")[1].operation_id, "3");
      await expect(Promise.all(changes)).resolves.toEqual([undefined, undefined]);
    } finally {
      for (const save of saves) save.resolve();
      await client.stopSceneSubscription();
    }
  });

  it("waits for a replayed access change's receipt before the reconnect snapshot", async () => {
    const clock = new ManualClock();
    const { client, sockets } = await hostClient(clock);
    try {
      const change = client.setDrawPolicy("hosts");
      await settle();
      await reconnect(clock, sockets);
      expect(sentPolicies(sockets[1])).toEqual(["hosts"]);
      expect(sentFrames(sockets[1], "request_snapshot")).toEqual([]);
      await commitFirst(sockets[1], "2");
      expect(sentFrames(sockets[1], "request_snapshot")).toHaveLength(1);
      await expect(change).resolves.toBeUndefined();
    } finally {
      await client.stopSceneSubscription();
    }
  });

  it("sends a held access change once after the same client stops and starts again", async () => {
    const pendingStore = new InMemoryChalkWhiteboardV1PendingOperationStore();
    const { client, sockets } = await hostClient(new ManualClock(), { pendingStore });
    try {
      void client.setDrawPolicy("hosts").catch(() => undefined);
      await settle();
      await client.stopSceneSubscription();
      const restart = client.startSceneSubscription();
      void restart.catch(() => undefined);
      await settle();
      sockets[1]?.open();
      await settle();
      sockets[1]?.receive(welcome());
      await settle();
      const replayed = sentFrames(sockets[1], "set_draw_policy");
      expect(replayed.map((frame) => frame.policy)).toEqual(["hosts"]);
      commit(sockets[1], replayed[0].operation_id, "2");
      await settle();
      expect(sentFrames(sockets[1], "set_draw_policy")).toHaveLength(1);
      expect(await pendingStore.load()).toEqual([]);
    } finally {
      await client.stopSceneSubscription();
    }
  });

  it("sends a policy change and a drawing made during a snapshot in the order they were made once it completes", async () => {
    const { client, sockets } = await hostClient();
    try {
      const snapshot = client.requestSnapshot();
      await settle();
      const policy = client.setDrawPolicy("hosts");
      await settle();
      const drawing = client.submitUpdate({ sceneId, syncAll: false, elements: [rectangle()] });
      await settle();
      expect(sentFrames(sockets[0], "set_draw_policy", "submit_update")).toEqual([]);
      sockets[0]?.receive(snapshotPage(sockets[0]?.requestId()));
      await snapshot;
      await settle();
      const [policyFrame, drawingFrame] = sentFrames(sockets[0], "set_draw_policy", "submit_update");
      expect([policyFrame?.type, drawingFrame?.type]).toEqual(["set_draw_policy", "submit_update"]);
      commit(sockets[0], policyFrame.operation_id, "2");
      commit(sockets[0], drawingFrame.operation_id, "3");
      await expect(policy).resolves.toBeUndefined();
      await expect(drawing).resolves.toMatchObject({ revision: "3" });
    } finally {
      await client.stopSceneSubscription();
    }
  });

  it("sends a held access change when a snapshot fails for good", async () => {
    const { client, sockets } = await hostClient();
    const sent = () => sentFrames(sockets[0], "set_draw_policy", "set_draw_permission");
    try {
      const changes = [client.setDrawPolicy("hosts"), client.setDrawPolicy("everyone")];
      await settle();
      void client.requestSnapshot().catch(() => undefined);
      await settle();
      commit(sockets[0], sent()[0].operation_id, "1");
      await settle();
      expect(sent()).toHaveLength(1);

      sockets[0]?.receive({ type: "operation_error", correlation_id: sockets[0]?.requestId(), operation: "request_snapshot", code: "storage_unavailable", recoverable: false, message: "Storage failed." });
      await settle();
      expect(sent().map((frame) => frame.policy)).toEqual(["hosts", "everyone"]);
      commit(sockets[0], sent()[1].operation_id, "2");
      await expect(Promise.all(changes)).resolves.toEqual([undefined, undefined]);
    } finally {
      await client.stopSceneSubscription();
    }
  });

  it("replays access changes made in the same millisecond in the order they were made", async () => {
    const pendingStore = new InMemoryChalkWhiteboardV1PendingOperationStore();
    // Each id sorts before the one made just before it, so only createdAt can keep the order.
    let made = 0;
    const ids = { next: () => `ffffffff-ffff-4fff-8fff-${(0xffffffffffff - made++).toString(16)}` };
    await saveChangesAndStop({ pendingStore, ids }, (client) => {
      void client.setDrawPolicy("hosts").catch(() => undefined);
      void client.setDrawPolicy("picked").catch(() => undefined);
    });

    const second = restoredClient(new ManualClock(), pendingStore);
    try {
      await acceptSnapshot(second.sockets);
      expect(sentFrames(second.sockets[0], "set_draw_policy").map((frame) => frame.policy)).toEqual(["hosts"]);
    } finally {
      await second.client.stopSceneSubscription();
    }
  });

  it.each([
    { write: "before", save: "finishes" },
    { write: "after", save: "finishes" },
    { write: "before", save: "fails" },
    { write: "after", save: "fails" },
  ] as const)("refuses a policy change without waiting for its save when the client falls back to a Sync without draw_policy_v1, and cleans up once the save $save, with a store that writes $write the wait", async ({ write, save }) => {
    const unhandled = unhandledRejections();
    const { pendingStore, saves } = heldPolicyStore(write);
    const clock = new ManualClock();
    const { client, sockets } = await hostClient(clock, { pendingStore });
    try {
      const { change } = await policyChangeOnDroppedConnection(client, sockets, clock);
      const caller = settlement(change);
      sockets[1]?.close(1009);
      await redial(clock, sockets, 2);
      sockets[2]?.receive(welcome());
      await settle();
      expect(helloExtensions(sockets[2])).toEqual(withoutDrawPolicy);
      expect(await unhandled.after()).toEqual([]);
      expect(caller.settled).toBe(true);

      if (save === "finishes") saves[0]?.resolve();
      else saves[0]?.reject(new Error("disk full"));
      await settle();
      sockets[2]?.receive(snapshotPage(sockets[2]?.requestId()));
      await settle();
      expect(sentFrames(sockets[2], "set_draw_policy")).toEqual([]);
      await expect(change).rejects.toMatchObject({ operation: "set_draw_policy", code: "unavailable", message: policyUnavailableMessage });
      await expectNothingLeft(pendingStore, unhandled);
    } finally {
      unhandled.stop();
      // Stop waits for pending saves, so a failed check must not leave one held.
      for (const save of saves) save.resolve();
      await client.stopSceneSubscription();
    }
  });

  it("rejects a change with the closed connection without waiting for its save, and only once when that save then fails", async () => {
    const unhandled = unhandledRejections();
    const { pendingStore, saves } = heldPolicyStore("after");
    const { client, sockets } = await hostClient(new ManualClock(), { pendingStore });
    try {
      const change = client.setDrawPolicy("hosts");
      const caller = settlement(change);
      await settle();
      sockets[0]?.close(1008);
      await settle();
      expect(await unhandled.after()).toEqual([]);
      expect(caller.settled).toBe(true);
      saves[0]?.reject(new Error("disk full"));
      await expect(change).rejects.toMatchObject({ operation: "set_draw_policy", code: "permission_denied", recoverable: false });
      await expectNothingLeft(pendingStore, unhandled);
    } finally {
      unhandled.stop();
      // Stop waits for pending saves, so a failed check must not leave one held.
      for (const save of saves) save.resolve();
      await client.stopSceneSubscription();
    }
  });

  it("with an older Sync, falls back and refuses a host's policy change that was waiting on the dropped connection", async () => {
    const clock = new ManualClock();
    const { client, sockets } = await hostClient(clock);
    try {
      const { change } = await policyChangeOnDroppedConnection(client, sockets, clock);
      sockets[1]?.close(1009, "invalid whiteboard frame");
      clock.advance(5_000);
      await acceptSnapshot(sockets, 2);
      expect(helloExtensions(sockets[2])).toEqual(withoutDrawPolicy);
      expect(sentFrames(sockets[2], "set_draw_policy")).toEqual([]);
      await expect(change).rejects.toMatchObject({ operation: "set_draw_policy", code: "unavailable", recoverable: true });
    } finally {
      await client.stopSceneSubscription();
    }
  });

  it("with a current Sync, keeps its hello and a saved policy change when a token is rejected once, and gives up after repeated rejections", async () => {
    const pendingStore = new InMemoryChalkWhiteboardV1PendingOperationStore();
    await saveChangesAndStop({ pendingStore }, (client) => void client.setDrawPolicy("hosts").catch(() => undefined));

    const clock = new ManualClock();
    const second = restoredClient(clock, pendingStore);
    try {
      await settle();
      // Sync's hello deadline can pass while the token is still being fetched.
      second.sockets[0]?.open();
      second.sockets[0]?.close(1008, "hello timeout");
      await redial(clock, second.sockets, 1);
      second.sockets[1]?.close(1008, "invalid token");
      await redial(clock, second.sockets, 2);
      second.sockets[2]?.receive(welcome());
      await settle();
      expect(helloExtensions(second.sockets[2])).toEqual([...withoutDrawPolicy, { name: "draw_policy_v1" }]);
      expect(sentFrames(second.sockets[2], "set_draw_policy").map((frame) => frame.policy)).toEqual(["hosts"]);
    } finally {
      await second.client.stopSceneSubscription();
    }

    const rejected = recoveryClient(clock);
    const rejectedStartup = rejected.client.startSceneSubscription();
    void rejectedStartup.catch(() => undefined);
    try {
      for (let index = 0; index < 5; index += 1) {
        await redial(clock, rejected.sockets, index, 0);
        rejected.sockets[index]?.close(1008, "invalid token");
        clock.advance(10_000);
      }
      await expect(rejectedStartup).rejects.toMatchObject({ code: "permission_denied", recoverable: false });
      expect(rejected.sockets.map((socket) => helloExtensions(socket).length)).toEqual([3, 3, 3, 3, 3]);
    } finally {
      await rejected.client.stopSceneSubscription();
    }
  });

  it("with an older Sync, refuses a saved policy change on the summary instead of replaying it", async () => {
    const pendingStore = new InMemoryChalkWhiteboardV1PendingOperationStore();
    const person = "20000000-0000-4000-8000-000000000002";
    await saveChangesAndStop({ pendingStore }, (client) => {
      void client.setDrawPolicy("hosts").catch(() => undefined);
      void client.setDrawPermission(person, false).catch(() => undefined);
    });

    const clock = new ManualClock();
    const second = recoveryClient(clock, undefined, { pendingStore });
    const errors: (string | undefined)[] = [];
    second.client.subscribeSummary((summary) => errors.push(summary.error?.operation));
    const startup = second.client.startSceneSubscription();
    try {
      await redial(clock, second.sockets, 0, 0);
      second.sockets[0]?.close(1009, "invalid whiteboard frame");
      await redial(clock, second.sockets, 1, 1_000);
      second.sockets[1]?.receive(welcome());
      await settle();
      expect(helloExtensions(second.sockets[1])).toEqual(withoutDrawPolicy);
      expect(errors).toContain("set_draw_policy");
      expect(sentFrames(second.sockets[1], "set_draw_policy")).toEqual([]);
      const permissions = sentFrames(second.sockets[1], "set_draw_permission");
      expect(permissions.map((frame) => frame.can_draw)).toEqual([false]);
      expect((await pendingStore.load()).map((pending) => pending.frame.type)).toEqual(["set_draw_permission"]);
      commit(second.sockets[1], permissions[0].operation_id, "1");
      await settle();
      second.sockets[1]?.receive(snapshotPage(second.sockets[1]?.requestId()));
      await startup;
    } finally {
      await second.client.stopSceneSubscription();
    }
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

/** A live client that drops its socket and queues a Bring while it reconnects. */
async function bringWhileReconnecting() {
  const clock = new ManualClock();
  const { client, sockets } = await startedRecoveryClient(clock);
  const bring = { x: 10, y: 20, width: 300, height: 200, bring: true };
  sockets[0]?.close(1006);
  expect(client.sendView(bring)).toBe(true);
  return { clock, client, sockets, bring };
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
  const socket = await acceptWelcome(sockets, index);
  socket?.receive(snapshotPage(socket.requestId()));
}

async function acceptWelcome(sockets: readonly TestSocket[], index = 0, ownerId?: string) {
  await settle();
  const socket = sockets[index];
  socket?.open();
  await settle();
  socket?.receive({ ...welcome(), ...(ownerId ? { view_owner_id: ownerId } : {}) });
  await settle();
  return socket;
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

const withoutDrawPolicy = [{ name: "presentation_v1" }, { name: "view_v1", origins: true }];

/** A live client whose person is a host, under the given call-wide policy. */
async function hostClient(clock = new ManualClock(), options: Partial<ChalkWhiteboardV1ClientOptions> = {}, policy: ChalkWhiteboardDrawPolicy = "everyone") {
  const started = await startedRecoveryClient(clock, undefined, options);
  started.sockets[0]?.receive({ type: "draw_access", policy, can_draw: true, capabilities: ["drawWhiteboard", "manageWhiteboard"], grants: [] });
  await settle();
  return started;
}

/** Makes access changes as a host, then stops, so the next client restores them from the same store. */
async function saveChangesAndStop(options: Partial<ChalkWhiteboardV1ClientOptions>, change: (client: ChalkWhiteboardV1Client) => void) {
  const { client } = await hostClient(new ManualClock(), options);
  change(client);
  await settle();
  await client.stopSceneSubscription();
}

/** A client that restores the store's saved changes as it starts. */
function restoredClient(clock: ManualClock, pendingStore: InMemoryChalkWhiteboardV1PendingOperationStore) {
  const restored = recoveryClient(clock, undefined, { pendingStore });
  void restored.client.startSceneSubscription().catch(() => undefined);
  return restored;
}

/** Starts a policy change, then drops the socket and opens the next one, as a Sync rollback would. */
async function policyChangeOnDroppedConnection(client: ChalkWhiteboardV1Client, sockets: readonly TestSocket[], clock: ManualClock) {
  const change = client.setDrawPolicy("hosts");
  void change.catch(() => undefined);
  await settle();
  sockets[0]?.close(1006);
  await redial(clock, sockets, 1);
  return { change };
}

/** A store whose policy saves wait for the test, written to the store before or after that wait. */
function heldPolicyStore(write: "before" | "after") {
  const saves: PromiseWithResolvers<void>[] = [];
  const pendingStore = new (class extends InMemoryChalkWhiteboardV1PendingOperationStore {
    override async put(operation: ChalkWhiteboardV1PendingOperation): Promise<void> {
      if (operation.frame.type !== "set_draw_policy") return super.put(operation);
      if (write === "before") await super.put(operation);
      const save = Promise.withResolvers<void>();
      saves.push(save);
      await save.promise;
      if (write === "after") await super.put(operation);
    }
  })();
  return { pendingStore, saves };
}

/** A host whose first policy change is saved and sent, and whose second waits on its save. */
async function twoQueuedPolicyChanges() {
  const clock = new ManualClock();
  const { pendingStore, saves } = heldPolicyStore("before");
  const { client, sockets } = await hostClient(clock, { pendingStore });
  const changes = [client.setDrawPolicy("hosts"), client.setDrawPolicy("picked")];
  for (const change of changes) void change.catch(() => undefined);
  await settle();
  saves[0]?.resolve();
  await settle();
  expect(sentPolicies(sockets[0])).toEqual(["hosts"]);
  const first = () => sentFrames(sockets[0], "set_draw_policy")[0].operation_id;
  return { client, sockets, saves, changes, first, clock };
}

function sentPolicies(socket: TestSocket | undefined): string[] {
  return sentFrames(socket, "set_draw_policy").map((frame) => frame.policy);
}

const SAVE_ORDERS = [
  [0, 1, 2],
  [0, 2, 1],
  [1, 0, 2],
  [1, 2, 0],
  [2, 0, 1],
  [2, 1, 0],
];

/** Each way to cut the order into turns, where saves in one turn finish together before the client runs again. */
function turnsOf(order: readonly number[]): number[][][] {
  return [0, 1, 2, 3].map((cuts) => {
    const turns: number[][] = [[order[0] ?? 0]];
    for (let index = 1; index < order.length; index += 1) {
      if (cuts & (1 << (index - 1))) turns.push([]);
      turns.at(-1)?.push(order[index] ?? 0);
    }
    return turns;
  });
}

function outcomesOf(count: number): boolean[][] {
  return Array.from({ length: 2 ** count }, (_, mask) => Array.from({ length: count }, (_, index) => (mask & (1 << index)) === 0));
}

type Decision = "wait" | "receipt" | "failure";

function decisionsOf(count: number): Decision[][] {
  if (count === 0) return [[]];
  return decisionsOf(count - 1).flatMap((rest) => (["wait", "receipt", "failure"] as const).map((decision) => [decision, ...rest]));
}

/**
 * Makes three policy changes, finishes their saves turn by turn, and decides the sent change after each turn as told.
 * Then it answers every change still sent, and checks that each saved change went out once, in creation order.
 */
async function expectCreationOrder({ write, turns, saved, decisions }: { write: "before" | "after"; turns: number[][]; saved: boolean[]; decisions: Decision[] }) {
  const label = JSON.stringify({ write, turns, saved, decisions });
  const policies = ["hosts", "picked", "everyone"] as const;
  const { pendingStore, saves } = heldPolicyStore(write);
  const { client, sockets } = await hostClient(new ManualClock(), { pendingStore });
  const socket = sockets[0];
  const changes = policies.map((policy) =>
    client.setDrawPolicy(policy).then(
      () => "resolved",
      (failed: { readonly code?: string }) => failed.code,
    ),
  );
  const answers = new Map<string, Decision>();
  let revision = 1;
  const decide = async (decision: Decision) => {
    const undecided = sentFrames(socket, "set_draw_policy").filter((frame) => !answers.has(frame.policy));
    expect(undecided.length, label).toBeLessThanOrEqual(1);
    const [frame] = undecided;
    if (!frame || decision === "wait") return;
    answers.set(frame.policy, decision);
    if (decision === "receipt") commit(socket, frame.operation_id, String((revision += 1)));
    else socket?.receive({ type: "operation_error", correlation_id: frame.operation_id, operation: "set_draw_policy", code: "permission_denied", recoverable: false, message: "Permission denied." });
    await settle();
  };
  try {
    await settle();
    for (const [index, turn] of turns.entries()) {
      for (const change of turn) {
        if (saved[change]) saves[change]?.resolve();
        else saves[change]?.reject(new Error("disk full"));
      }
      await settle();
      await decide(decisions[index] ?? "wait");
    }
    for (let drained = 0; drained < policies.length; drained += 1) await decide("receipt");

    expect(sentPolicies(socket), label).toEqual(policies.filter((_, index) => saved[index]));
    const expected = policies.map((policy, index) => (!saved[index] ? "unavailable" : answers.get(policy) === "failure" ? "permission_denied" : "resolved"));
    expect(await Promise.all(changes), label).toEqual(expected);
    expect(await pendingStore.load(), label).toEqual([]);
  } finally {
    for (const save of saves) save.resolve();
    await client.stopSceneSubscription();
  }
}

const policyUnavailableMessage = "The call-wide drawing policy is unavailable on this Sync server.";

/** Collects unhandled promise rejections, so a test can show that each caller's failure reached a handler. */
function unhandledRejections() {
  const reasons: string[] = [];
  const listener = (reason: unknown) => reasons.push(String(reason));
  process.on("unhandledRejection", listener);
  return {
    after: async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      return reasons;
    },
    stop: () => process.off("unhandledRejection", listener),
  };
}

/** Handles a caller's promise at once and records when it settles, so a test can check it while a save is still held. */
function settlement(promise: Promise<unknown>) {
  const state = { settled: false };
  void promise.then(
    () => (state.settled = true),
    () => (state.settled = true),
  );
  return state;
}

/** Drops the first connection, then dials and welcomes the second. */
async function reconnect(clock: ManualClock, sockets: readonly TestSocket[]) {
  sockets[0]?.close(1006);
  await redial(clock, sockets, 1);
  sockets[1]?.receive(welcome());
  await settle();
}

async function commitFirst(socket: TestSocket | undefined, revision: string) {
  commit(socket, sentFrames(socket, "set_draw_policy")[0].operation_id, revision);
  await settle();
}

async function expectNothingLeft(pendingStore: InMemoryChalkWhiteboardV1PendingOperationStore, unhandled: ReturnType<typeof unhandledRejections>) {
  expect(await pendingStore.load()).toEqual([]);
  expect(await unhandled.after()).toEqual([]);
}

/** Lets the reconnect timer dial, then opens the socket it made. */
async function redial(clock: ManualClock, sockets: readonly TestSocket[], index: number, milliseconds = 5_000) {
  clock.advance(milliseconds);
  await settle();
  sockets[index]?.open();
  await settle();
}

function commit(socket: TestSocket | undefined, operationId: string, revision: string) {
  socket?.receive({ type: "commit", operation_id: operationId, outcome: "committed", scene_id: sceneId, revision });
}

function sentFrames(socket: TestSocket | undefined, ...types: string[]) {
  const frames = (socket?.sent ?? []).map((wire) => JSON.parse(wire));
  return types.length === 0 ? frames : frames.filter((frame) => types.includes(frame.type));
}

function helloExtensions(socket: TestSocket | undefined): readonly unknown[] {
  return sentFrames(socket)[0]?.extensions ?? [];
}
it("judge: a saved first change stays ahead when a later save rejects in the same turn", async () => {
  const { pendingStore, saves } = heldPolicyStore("before");
  const { client, sockets } = await hostClient(new ManualClock(), { pendingStore });
  const changes = [client.setDrawPolicy("hosts"), client.setDrawPolicy("picked"), client.setDrawPolicy("everyone")];
  for (const change of changes) void change.catch(() => undefined);
  try {
    await settle();
    saves[2]?.resolve();
    await settle();
    expect(sentPolicies(sockets[0])).toEqual([]);
    saves[0]?.resolve();
    saves[1]?.reject(new Error("disk full"));
    await settle();
    const initialOrder = sentPolicies(sockets[0]);
    commit(sockets[0], sentFrames(sockets[0], "set_draw_policy").at(-1).operation_id, "1");
    await settle();
    const completeOrder = sentPolicies(sockets[0]);
    commit(sockets[0], sentFrames(sockets[0], "set_draw_policy").at(-1).operation_id, "2");
    await expect(changes[0]).resolves.toBeUndefined();
    await expect(changes[1]).rejects.toMatchObject({ code: "unavailable" });
    await expect(changes[2]).resolves.toBeUndefined();
    expect({ initialOrder, completeOrder }).toEqual({ initialOrder: ["hosts"], completeOrder: ["hosts", "everyone"] });
  } finally {
    for (const save of saves) save.resolve();
    await client.stopSceneSubscription();
  }
});

it("judge: a stale receipt after welcome cannot release the next access slot", async () => {
  const clock = new ManualClock();
  const { client, sockets } = await hostClient(clock);
  try {
    const a = client.setDrawPolicy("hosts");
    const b = client.setDrawPolicy("picked");
    await settle();
    const first = sentFrames(sockets[0], "set_draw_policy")[0].operation_id;
    commit(sockets[0], first, "1");
    await a;
    await settle();
    sockets[0]?.close(1006);
    await redial(clock, sockets, 1);
    sockets[1]?.receive(welcome());
    await settle();
    expect(sentPolicies(sockets[1])).toEqual(["picked"]);
    commit(sockets[1], first, "1");
    await settle();
    expect(sentPolicies(sockets[1])).toEqual(["picked"]);
    commit(sockets[1], sentFrames(sockets[1], "set_draw_policy")[0].operation_id, "2");
    await b;
  } finally {
    await client.stopSceneSubscription();
  }
});

it("judge: final failure while the next save is pending releases exactly one slot", async () => {
  const q = await twoQueuedPolicyChanges();
  try {
    q.sockets[0]?.receive({ type: "operation_error", correlation_id: q.first(), operation: "set_draw_policy", code: "permission_denied", recoverable: false, message: "Permission denied." });
    await settle();
    expect(sentPolicies(q.sockets[0])).toEqual(["hosts"]);
    q.saves[1]?.resolve();
    await settle();
    expect(sentPolicies(q.sockets[0])).toEqual(["hosts", "picked"]);
    commit(q.sockets[0], sentFrames(q.sockets[0], "set_draw_policy").at(-1).operation_id, "2");
    await expect(q.changes[0]).rejects.toMatchObject({ code: "permission_denied" });
    await expect(q.changes[1]).resolves.toBeUndefined();
  } finally {
    for (const save of q.saves) save.resolve();
    await q.client.stopSceneSubscription();
  }
});

it("judge: a failed later save does not resend an access change already awaiting its receipt", async () => {
  let saves = 0;
  const secondSave = Promise.withResolvers<void>();
  const pendingStore = new (class extends InMemoryChalkWhiteboardV1PendingOperationStore {
    override async put(operation: Parameters<InMemoryChalkWhiteboardV1PendingOperationStore["put"]>[0]): Promise<void> {
      if (operation.frame.type === "set_draw_policy" && ++saves === 2) await secondSave.promise;
      await super.put(operation);
    }
  })();
  const { client, sockets } = await startedRecoveryClient(new ManualClock(), undefined, { pendingStore });
  const sent = () => (sockets[0]?.sent ?? []).map((wire) => JSON.parse(wire)).filter((frame) => frame.type === "set_draw_policy");
  try {
    sockets[0]?.receive({ type: "draw_access", policy: "everyone", can_draw: true, capabilities: ["drawWhiteboard", "manageWhiteboard"], grants: [] });
    await settle();
    const first = client.setDrawPolicy("hosts");
    void first.catch(() => undefined);
    await settle();
    expect(sent()).toHaveLength(1);
    const second = client.setDrawPolicy("picked");
    void second.catch(() => undefined);
    await settle();
    secondSave.reject(new Error("disk full"));
    await expect(second).rejects.toMatchObject({ code: "unavailable" });
    await settle();
    expect(sent()).toHaveLength(1);
  } finally {
    secondSave.resolve();
    await client.stopSceneSubscription();
  }
});

it("judge: a failed save cannot replay after restart while its deletion is still pending", async () => {
  const deletion = Promise.withResolvers<void>();
  let failedId: string | undefined;
  let writes = 0;
  const pendingStore = new (class extends InMemoryChalkWhiteboardV1PendingOperationStore {
    override async put(operation: ChalkWhiteboardV1PendingOperation): Promise<void> {
      await super.put(operation);
      if (++writes === 1) {
        failedId = operation.operationId;
        throw new Error("disk failed after writing");
      }
    }
    override async remove(operationId: string): Promise<void> {
      if (operationId === failedId) await deletion.promise;
      await super.remove(operationId);
    }
  })();
  const { client, sockets } = await hostClient(new ManualClock(), { pendingStore });
  let restart: Promise<void> | undefined;
  try {
    await expect(client.setDrawPolicy("hosts")).rejects.toMatchObject({ code: "unavailable" });
    const later = client.setDrawPolicy("everyone");
    await settle();
    expect(sentPolicies(sockets[0])).toEqual(["everyone"]);
    commit(sockets[0], sentFrames(sockets[0], "set_draw_policy")[0].operation_id, "2");
    await later;
    let stopped = false;
    const stopping = client.stopSceneSubscription().then(() => {
      stopped = true;
    });
    void stopping.catch(() => undefined);
    restart = client.startSceneSubscription();
    void restart.catch(() => undefined);
    await settle();
    expect(stopped).toBe(false);
    expect(sockets).toHaveLength(1);
    deletion.resolve();
    await stopping;
    await settle();
    sockets[1]?.open();
    await settle();
    sockets[1]?.receive(welcome());
    await settle();
    expect(sentPolicies(sockets[1])).toEqual([]);
    sockets[1]?.receive(snapshotPage(sockets[1]?.requestId()));
    await restart;
    expect(await pendingStore.load()).toEqual([]);
  } finally {
    deletion.resolve();
    await settle();
    await client.stopSceneSubscription();
    await restart?.catch(() => undefined);
  }
});

it("judge: an old-Sync refusal cannot replay after restart while its deletion is still pending", async () => {
  const deletion = Promise.withResolvers<void>();
  const pendingStore = new (class extends InMemoryChalkWhiteboardV1PendingOperationStore {
    override async remove(operationId: string): Promise<void> {
      await deletion.promise;
      await super.remove(operationId);
    }
  })();
  const clock = new ManualClock();
  const { client, sockets } = await hostClient(clock, { pendingStore });
  let restart: Promise<void> | undefined;
  try {
    const { change } = await policyChangeOnDroppedConnection(client, sockets, clock);
    sockets[1]?.close(1009, "invalid whiteboard frame");
    await redial(clock, sockets, 2);
    sockets[2]?.receive(welcome());
    await settle();
    await expect(change).rejects.toMatchObject({ code: "unavailable" });
    expect(sentPolicies(sockets[2])).toEqual([]);
    let stopped = false;
    const stopping = client.stopSceneSubscription().then(() => {
      stopped = true;
    });
    void stopping.catch(() => undefined);
    restart = client.startSceneSubscription();
    void restart.catch(() => undefined);
    await settle();
    expect(stopped).toBe(false);
    expect(sockets).toHaveLength(3);
    deletion.resolve();
    await stopping;
    await settle();
    sockets[3]?.open();
    await settle();
    sockets[3]?.receive(welcome());
    await settle();
    expect(sentPolicies(sockets[3])).toEqual([]);
    sockets[3]?.receive(snapshotPage(sockets[3]?.requestId()));
    await restart;
    expect(await pendingStore.load()).toEqual([]);
  } finally {
    deletion.resolve();
    await settle();
    await client.stopSceneSubscription();
    await restart?.catch(() => undefined);
  }
});

it("adopts the owner's snapshot on reconnect and ignores the previous owner's messages", async () => {
  const clock = new TestClock();
  const { client, sockets } = recoveryClient(clock);
  const startup = client.startSceneSubscription();
  const owner = "40000000-0000-4000-8000-000000000004";
  const nextOwner = "50000000-0000-4000-8000-000000000005";
  const views: Extract<ChalkWhiteboardV1Event, { type: "view" }>[] = [];
  client.subscribe((event) => {
    if (event.type === "view") views.push(event);
  });
  const view = (ownerId: string, sequence: number, x: number) => ({ type: "view", participant_id: sceneId, display_name: "Person", x, y: 0, width: 100, height: 100, bring: false, occurred_at: "2026-10-23T00:00:00Z", owner_id: ownerId, owner_sequence: sequence });
  try {
    await settle();
    sockets[0]?.open();
    await settle();
    sockets[0]?.receive({ ...welcome(), view_owner_id: owner });
    await settle();
    sockets[0]?.receive(view(owner, 100, 100));
    sockets[0]?.receive(snapshotPage(sockets[0]?.requestId()));
    await startup;
    sockets[0]?.receive(view(owner, 99, 99));
    expect(views.map((v) => v.x)).toEqual([100]);
    sockets[0]?.close(1012);
    const replay: ChalkWhiteboardV1Event[] = [];
    const off = client.subscribe((event) => replay.push(event));
    off();
    expect(replay.filter((e) => e.type === "view")).toEqual([]);
    clock.advance(1000);
    await settle();
    sockets[1]?.open();
    await settle();
    sockets[1]?.receive({ ...welcome(), view_owner_id: nextOwner });
    await settle();
    sockets[1]?.receive(view(nextOwner, 1, 20));
    sockets[1]?.receive(view(owner, 101, 999));
    sockets[1]?.receive(snapshotPage(sockets[1]?.requestId()));
    await settle();
    expect(views.map((v) => v.x)).toEqual([100, 20]);
  } finally {
    await client.stopSceneSubscription();
  }
});

it("keeps a real recovery-time move when a heartbeat follows it", async () => {
  const { client, sockets } = recoveryClient();
  const startup = client.startSceneSubscription();
  try {
    await acceptWelcome(sockets, 0, "40000000-0000-4000-8000-000000000004");
    client.sendView({ x: 12, y: 0, width: 100, height: 100, bring: false, lead: true });
    client.sendView({ x: 999, y: 0, width: 100, height: 100, bring: false });
    sockets[0]?.receive(snapshotPage(sockets[0]?.requestId()));
    await startup;
    const sent = sockets[0]?.sent.map((wire) => JSON.parse(wire)).filter((f) => f.type === "view");
    expect(sent).toEqual([expect.objectContaining({ x: 12, move: true, input_id: expect.stringMatching(/:[1-9][0-9]*$/) })]);
  } finally {
    await client.stopSceneSubscription();
  }
});

it("keeps the canonical source on an intentional Follow selection", async () => {
  const { client, sockets } = recoveryClient();
  const startup = client.startSceneSubscription();
  try {
    await acceptWelcome(sockets, 0, "40000000-0000-4000-8000-000000000004");
    sockets[0]?.receive(snapshotPage(sockets[0]?.requestId()));
    await startup;
    client.sendView({ x: 999, y: 0, width: 100, height: 100, bring: false, lead: true, originParticipantId: sceneId, originSequence: 42 });
    expect(JSON.parse(sockets[0]?.sent.at(-1) ?? "{}")).toMatchObject({ move: true, origin_participant_id: sceneId, origin_sequence: 42 });
  } finally {
    await client.stopSceneSubscription();
  }
});
