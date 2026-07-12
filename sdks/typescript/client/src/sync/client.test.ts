import { describe, expect, it } from "vitest";
import { createBrowserSyncLifecycle } from "./browser";
import { computeStateDigest } from "./canonical";
import { SyncClient } from "./client";
import { SyncPersistenceError } from "./index";
import { SyncProtocolLimits, encodedSyncFrameBytes } from "../generated/sync-v2";
import { InMemoryPendingCommandStore, type PendingCommandStore } from "./persistence";
import { jsonSyncProtocolCodec } from "./protocol";
import { event, ids, isDeliveryAck, isRecoveryAck, participantSessionId, sent, setHand, settle, stateSchemaVersion, TestClock, TestSockets } from "./__tests__/runtime";
import type { ControlState, PendingCommand } from "./types";
import { syncV2ProtocolCodec } from "./v2-codec";

describe("SyncClient", () => {
  it("reconciles ACK-before-event and event-before-ACK while retaining retryable pending work", async () => {
    const clock = new TestClock();
    const sockets = new TestSockets();
    const client = new SyncClient({
      url: "ws://sync.test/v2/sync",
      token: async () => "top-secret-token",
      webSocket: sockets,
      codec: jsonSyncProtocolCodec,
      clock,
      ids: ids("command-00000001", "command-00000002", "command-00000003"),
      random: () => 0.5,
    });

    await client.start();
    const socket = sockets.latest();
    socket.open();
    await settle();
    expect(sent(socket)[0]).toMatchObject({ type: "hello", token: "top-secret-token" });

    const initialState: ControlState = { status: "active", participants: [{ participantSessionId, displayName: "Private Name", handRaised: false }] };
    const initialDigest = await computeStateDigest(initialState, 1, stateSchemaVersion);
    socket.receive({
      type: "welcome",
      protocol: 2,
      participantSessionId,
      participantSessionGeneration: 1,
      recoveryId: "snapshot-1",
      mode: "snapshot",
      head: { revision: 1, stateSchemaVersion, stateDigest: initialDigest },
      snapshot: { state: initialState, revision: 1, stateSchemaVersion, stateDigest: initialDigest },
    });
    socket.receive({ type: "recovery_complete", recoveryId: "snapshot-1", head: { revision: 1, stateSchemaVersion, stateDigest: initialDigest } });
    await settle();
    expect(client.getSnapshot().connection.phase).toBe("live");

    const raiseId = await client.send({ name: "raise_hand" });
    expect(client.getSnapshot().optimistic.participants[0]?.handRaised).toBe(true);
    socket.receive({ type: "ack", commandId: raiseId, result: "committed", eventId: "event-2", revision: 2 });
    await settle();
    expect(client.getSnapshot().pending.count).toBe(1);

    const raisedState = setHand(initialState, true);
    socket.receive(
      event({
        eventId: "event-2",
        name: "hand_raised",
        baseRevision: 1,
        revision: 2,
        commandId: raiseId,
        payload: { participantSessionId },
        resultingStateDigest: await computeStateDigest(raisedState, 2, stateSchemaVersion),
      }),
    );
    await settle();
    expect(client.getSnapshot().pending.count).toBe(0);
    expect(client.getSnapshot().canonical?.state.participants[0]?.handRaised).toBe(true);
    expect(sent(socket).filter(isDeliveryAck)).toEqual([{ type: "delivery_ack", stream: "control", revision: 2, stateDigest: await computeStateDigest(raisedState, 2, stateSchemaVersion) }]);

    const lowerId = await client.send({ name: "lower_hand" });
    const loweredState = setHand(raisedState, false);
    socket.receive(
      event({
        eventId: "event-3",
        name: "hand_lowered",
        baseRevision: 2,
        revision: 3,
        commandId: lowerId,
        payload: { participantSessionId },
        resultingStateDigest: await computeStateDigest(loweredState, 3, stateSchemaVersion),
      }),
    );
    await settle();
    socket.receive({ type: "ack", commandId: lowerId, result: "duplicate", eventId: "event-3", revision: 3 });
    await settle();
    expect(client.getSnapshot().pending.count).toBe(0);

    const retryId = await client.send({ name: "raise_hand" });
    socket.receive({ type: "retryable_error", commandId: retryId, code: "dependency_unavailable" });
    await settle();
    expect(client.getSnapshot().pending.commands.map((command) => command.commandId)).toEqual([retryId]);
    socket.receive({ type: "ack", commandId: retryId, result: "rejected", reason: "invalid_state" });
    await settle();
    expect(client.getSnapshot().pending.count).toBe(0);
    expect(client.getSnapshot().failures.at(-1)).toMatchObject({ commandId: retryId, kind: "terminal_rejection", reason: "invalid_state" });
    expect(JSON.stringify(client.getDiagnostics())).not.toContain("top-secret-token");
    expect(JSON.stringify(client.getDiagnostics())).not.toContain("Private Name");
  });

  it("acknowledges snapshot and replay only after applying their resulting state", async () => {
    const sockets = new TestSockets();
    const client = new SyncClient({
      url: "ws://sync.test/v2/sync",
      token: async () => "token",
      webSocket: sockets,
      codec: jsonSyncProtocolCodec,
      clock: new TestClock(),
    });
    const initialState: ControlState = { status: "active", participants: [{ participantSessionId, displayName: "Ada", handRaised: false }] };
    const initialDigest = await computeStateDigest(initialState, 1, stateSchemaVersion);

    await client.start();
    const initialSocket = sockets.latest();
    initialSocket.open();
    await settle();
    initialSocket.receive({
      type: "welcome",
      protocol: 2,
      participantSessionId,
      participantSessionGeneration: 1,
      recoveryId: "snapshot-1",
      mode: "snapshot",
      head: { revision: 1, stateSchemaVersion, stateDigest: initialDigest },
      snapshot: { state: initialState, revision: 1, stateSchemaVersion, stateDigest: initialDigest },
    });
    initialSocket.receive({ type: "recovery_complete", recoveryId: "snapshot-1", head: { revision: 1, stateSchemaVersion, stateDigest: initialDigest } });
    await settle();
    expect(sent(initialSocket).filter(isRecoveryAck)).toEqual([{ type: "recovery_ack", recoveryId: "snapshot-1", revision: 1, stateDigest: initialDigest }]);

    client.stop();
    await client.start();
    const recoverySocket = sockets.latest();
    recoverySocket.open();
    await settle();
    const raisedState = setHand(initialState, true);
    const raisedDigest = await computeStateDigest(raisedState, 2, stateSchemaVersion);
    recoverySocket.receive({
      type: "welcome",
      protocol: 2,
      participantSessionId,
      participantSessionGeneration: 1,
      recoveryId: "replay-1",
      mode: "replay",
      head: { revision: 2, stateSchemaVersion, stateDigest: raisedDigest },
    });
    recoverySocket.receive({
      type: "replay_page",
      recoveryId: "replay-1",
      firstRevision: 2,
      lastRevision: 2,
      events: [
        event({
          eventId: "event-2",
          name: "hand_raised",
          baseRevision: 1,
          revision: 2,
          payload: { participantSessionId },
          resultingStateDigest: raisedDigest,
        }),
      ],
    });
    recoverySocket.receive({ type: "recovery_complete", recoveryId: "replay-1", head: { revision: 2, stateSchemaVersion, stateDigest: raisedDigest } });
    await settle();

    expect(sent(recoverySocket).filter(isDeliveryAck)).toEqual([]);
    expect(sent(recoverySocket).filter(isRecoveryAck)).toEqual([{ type: "recovery_ack", recoveryId: "replay-1", revision: 2, stateDigest: raisedDigest }]);
    expect(client.getSnapshot().canonical?.revision).toBe(2);

    const loweredState = setHand(raisedState, false);
    const loweredDigest = await computeStateDigest(loweredState, 3, stateSchemaVersion);
    recoverySocket.receive(
      event({
        eventId: "event-3",
        name: "hand_lowered",
        baseRevision: 2,
        revision: 3,
        payload: { participantSessionId },
        resultingStateDigest: loweredDigest,
      }),
    );
    await settle();

    expect(client.getSnapshot().canonical).toMatchObject({ revision: 3, stateDigest: loweredDigest, state: loweredState });
    expect(sent(recoverySocket).filter(isDeliveryAck)).toEqual([{ type: "delivery_ack", stream: "control", revision: 3, stateDigest: loweredDigest }]);
  });

  it("does not acknowledge a snapshot whose digest fails validation", async () => {
    const sockets = new TestSockets();
    const client = new SyncClient({
      url: "ws://sync.test/v2/sync",
      token: async () => "token",
      webSocket: sockets,
      codec: jsonSyncProtocolCodec,
      clock: new TestClock(),
    });
    const state: ControlState = { status: "active", participants: [{ participantSessionId, displayName: "Ada", handRaised: false }] };
    const invalidDigest = "0".repeat(64);

    await client.start();
    const socket = sockets.latest();
    socket.open();
    await settle();
    socket.receive({
      type: "welcome",
      protocol: 2,
      participantSessionId,
      participantSessionGeneration: 1,
      recoveryId: "invalid-snapshot",
      mode: "snapshot",
      head: { revision: 1, stateSchemaVersion, stateDigest: invalidDigest },
      snapshot: { state, revision: 1, stateSchemaVersion, stateDigest: invalidDigest },
    });
    await settle();

    expect(sent(socket).filter(isRecoveryAck)).toEqual([]);
    expect(client.getSnapshot().canonical).toBeNull();
  });

  it("clears a persisted command when snapshot recovery already contains its duplicate ACK revision", async () => {
    const commandId = "command-00000010";
    const store = new InMemoryPendingCommandStore([{ commandId, command: { name: "raise_hand" }, createdAt: 0, bytes: 1 }]);
    const { client, socket } = await startClientAtCommittedPendingRevision(store, "snapshot-after-commit");

    expect(client.getSnapshot().pending.count).toBe(1);
    expect(sent(socket)).toContainEqual({ type: "command", commandId, name: "raise_hand" });

    socket.receive({ type: "ack", commandId, result: "duplicate", eventId: "event-2", revision: 2 });
    await settle();

    expect(client.getSnapshot().pending.count).toBe(0);
    await expect(store.load()).resolves.toEqual([]);
  });

  it("retries durable cleanup when a settled command removal fails transiently", async () => {
    const commandId = "command-00000012";
    const command: PendingCommand = { commandId, command: { name: "raise_hand" }, createdAt: 0, bytes: 1 };
    const store = new FlakyRemovePendingStore(command);
    const { client, socket } = await startClientAtCommittedPendingRevision(store, "snapshot-after-transient-cleanup-failure");

    const acknowledgement = { type: "ack", commandId, result: "duplicate", eventId: "event-2", revision: 2 } as const;
    socket.receive(acknowledgement);
    await settle();
    expect(client.getSnapshot().pending.count).toBe(1);
    expect(store.removeCalls).toBe(1);

    socket.receive(acknowledgement);
    await settle();
    expect(client.getSnapshot().pending.count).toBe(0);
    expect(store.removeCalls).toBe(2);
    await expect(store.load()).resolves.toEqual([]);
  });

  it("enforces local pending capacity and surfaces persisted expired work", async () => {
    const clock = new TestClock();
    const expired: PendingCommand = { commandId: "command-00000004", command: { name: "raise_hand" }, createdAt: -101, bytes: 42 };
    const store = new InMemoryPendingCommandStore([expired]);
    const client = new SyncClient({
      url: "ws://sync.test/v2/sync",
      token: async () => "token",
      webSocket: new TestSockets(),
      codec: jsonSyncProtocolCodec,
      pendingStore: store,
      clock,
      ids: ids("command-00000005", "command-00000006"),
      limits: { maxPendingCommands: 1, maxPendingBytes: 1_000, maxPendingAgeMs: 100 },
    });

    await client.start();
    expect(client.getSnapshot().failures).toContainEqual(expect.objectContaining({ commandId: expired.commandId, kind: "expired" }));
    await client.send({ name: "raise_hand" });
    await expect(client.send({ name: "lower_hand" })).rejects.toMatchObject({ name: "SyncCapacityError", limit: "count" });
  });

  it("reserves pending capacity before asynchronous persistence completes", async () => {
    const store = new DeferredPutPendingStore();
    const client = new SyncClient({
      url: "ws://sync.test/v2/sync",
      token: async () => "token",
      webSocket: new TestSockets(),
      codec: jsonSyncProtocolCodec,
      pendingStore: store,
      ids: ids("command-00000013", "command-00000014"),
      limits: { maxPendingCommands: 1, maxPendingBytes: 1_000, maxPendingAgeMs: 1_000 },
    });

    const first = client.send({ name: "raise_hand" });
    expect(store.putCalls).toBe(1);
    await expect(client.send({ name: "lower_hand" })).rejects.toMatchObject({ name: "SyncCapacityError", limit: "count" });
    expect(store.putCalls).toBe(1);

    store.resolvePut(0);
    await expect(first).resolves.toBe("command-00000013");
    expect(client.getSnapshot().pending.count).toBe(1);
  });

  it("normalizes stored bytes and rejects oversized or nonempty generated payloads locally", async () => {
    const store = new InMemoryPendingCommandStore([{ commandId: "command-00000007", command: { name: "raise_hand" }, createdAt: 0, bytes: 1 }]);
    const client = new SyncClient({
      url: "ws://sync.test/v2/sync",
      token: async () => "token",
      webSocket: new TestSockets(),
      codec: jsonSyncProtocolCodec,
      pendingStore: store,
      clock: new TestClock(),
      ids: ids("command-00000008"),
      limits: { maxPendingCommands: 2, maxPendingBytes: 2, maxPendingAgeMs: 1_000 },
    });

    await client.start();
    expect(client.getSnapshot().failures).toContainEqual(expect.objectContaining({ commandId: "command-00000007", kind: "capacity" }));
    await expect(client.send({ name: "lower_hand" })).rejects.toMatchObject({ name: "SyncCapacityError", limit: "bytes" });
    await expect(client.send({ name: "raise_hand", payload: { unexpected: true } })).rejects.toMatchObject({ name: "SyncCommandValidationError" });
  });

  it("does not apply optimistic state when persistence rejects a command", async () => {
    const client = new SyncClient({
      url: "ws://sync.test/v2/sync",
      token: async () => "token",
      codec: jsonSyncProtocolCodec,
      webSocket: new TestSockets(),
      pendingStore: new FailingPendingStore(),
      ids: { next: () => "command-00000001" },
    });

    await expect(client.send({ name: "raise_hand" })).rejects.toBeInstanceOf(SyncPersistenceError);
    expect(client.getSnapshot().pending).toMatchObject({ count: 0, bytes: 0 });
  });

  it("retries the durable pending load after an initial storage failure", async () => {
    const command: PendingCommand = {
      commandId: "command-00000011",
      command: { name: "raise_hand" },
      createdAt: 0,
      bytes: 1,
    };
    const store = new FlakyLoadPendingStore(command);
    const client = new SyncClient({
      url: "ws://sync.test/v2/sync",
      token: async () => "token",
      codec: jsonSyncProtocolCodec,
      webSocket: new TestSockets(),
      pendingStore: store,
      clock: new TestClock(),
    });

    await expect(client.start()).rejects.toThrow("unable to load pending sync commands");
    await client.start();

    expect(store.loadCalls).toBe(2);
    expect(client.getSnapshot().pending.commands.map((pending) => pending.commandId)).toEqual([command.commandId]);
  });

  it("refreshes a token and reconnects after authentication requires rejoining", async () => {
    let token = "expired-token";
    const sockets = new TestSockets();
    const client = new SyncClient({
      url: "ws://sync.test/v2/sync",
      token: async () => token,
      webSocket: sockets,
      codec: jsonSyncProtocolCodec,
      clock: new TestClock(),
    });

    await client.start();
    const first = sockets.latest();
    first.open();
    await settle();
    expect(sent(first)[0]).toMatchObject({ type: "hello", token: "expired-token" });

    first.onclose?.({ code: 1008 });
    expect(client.getSnapshot().connection).toEqual({ phase: "stopped", reason: "rejoin_required" });

    token = "fresh-token";
    client.refresh();
    expect(sockets.sockets).toHaveLength(2);
    const refreshed = sockets.latest();
    refreshed.open();
    await settle();

    expect(sent(refreshed)[0]).toMatchObject({ type: "hello", token: "fresh-token" });
    expect(client.getSnapshot().connection.phase).toBe("recovering");
  });

  it("does not connect when browser lifecycle starts offline and hidden", async () => {
    const window = new EventTarget();
    const document = new TestDocument(true);
    const lifecycle = createBrowserSyncLifecycle({ window, document, navigator: { onLine: false } });
    const lifecycleEvents: string[] = [];
    const unsubscribe = lifecycle.subscribe((event) => lifecycleEvents.push(event));
    const sockets = new TestSockets();
    const client = new SyncClient({
      url: "ws://sync.test/v2/sync",
      token: async () => "token",
      webSocket: sockets,
      codec: jsonSyncProtocolCodec,
      lifecycle,
    });

    await client.start();

    expect(lifecycleEvents).toEqual(["offline", "inactive"]);
    expect(sockets.sockets).toEqual([]);
    unsubscribe();
  });

  it("does not install a lifecycle subscription after a stopped start finishes loading", async () => {
    const store = new DeferredLoadPendingStore();
    const lifecycle = new TestLifecycle();
    const sockets = new TestSockets();
    const client = new SyncClient({
      url: "ws://sync.test/v2/sync",
      token: async () => "token",
      webSocket: sockets,
      codec: jsonSyncProtocolCodec,
      pendingStore: store,
      lifecycle,
    });

    const firstStart = client.start();
    expect(store.loadCalls).toBe(1);
    client.stop();
    store.resolveLoad(0);
    await firstStart;

    expect(lifecycle.subscribeCalls).toBe(0);
    expect(lifecycle.activeSubscriptions).toBe(0);
    expect(sockets.sockets).toEqual([]);

    await client.start();
    await client.start();

    expect(lifecycle.subscribeCalls).toBe(1);
    expect(lifecycle.activeSubscriptions).toBe(1);
    expect(sockets.sockets).toHaveLength(1);
    client.stop();
    expect(lifecycle.activeSubscriptions).toBe(0);
    expect(lifecycle.unsubscribeCalls).toBe(1);
  });

  it("keeps only the latest lifecycle subscription when a stopped start load finishes late", async () => {
    const store = new DeferredLoadPendingStore();
    const lifecycle = new TestLifecycle();
    const client = new SyncClient({
      url: "ws://sync.test/v2/sync",
      token: async () => "token",
      webSocket: new TestSockets(),
      codec: jsonSyncProtocolCodec,
      pendingStore: store,
      lifecycle,
    });

    const firstStart = client.start();
    client.stop();
    const secondStart = client.start();
    expect(store.loadCalls).toBe(1);
    store.resolveLoad(0);
    await secondStart;
    await firstStart;

    expect(lifecycle.subscribeCalls).toBe(1);
    expect(lifecycle.activeSubscriptions).toBe(1);
  });

  it("accepts contract-valid replay and snapshot recovery frames above the command input cap", async () => {
    const replaySockets = new TestSockets();
    const replayClient = new SyncClient({
      url: "ws://sync.test/v2/sync",
      token: async () => "token",
      webSocket: replaySockets,
      codec: syncV2ProtocolCodec,
      clock: new TestClock(),
    });
    const clientParticipantId = uuid(1);
    const emptyState: ControlState = { status: "active", participants: [] };
    const emptyDigest = await computeStateDigest(emptyState, 0, stateSchemaVersion);

    await replayClient.start();
    const initialSocket = replaySockets.latest();
    initialSocket.open();
    await settle();
    initialSocket.receive(snapshotWelcome("00000000-0000-4000-8000-000000000002", clientParticipantId, emptyState, 0, emptyDigest));
    initialSocket.receive(recoveryComplete("00000000-0000-4000-8000-000000000002", 0, emptyDigest));
    await settle();
    replayClient.stop();

    await replayClient.start();
    const replaySocket = replaySockets.latest();
    replaySocket.open();
    await settle();
    const replay = await replayPage(clientParticipantId);

    expect(encodedSyncFrameBytes(replay.frame)).toBeGreaterThan(SyncProtocolLimits.decodedInboundFrameBytes);
    expect(encodedSyncFrameBytes(replay.frame)).toBeLessThanOrEqual(SyncProtocolLimits.replayPageEncodedBytes);
    replaySocket.receive(replay.welcome);
    replaySocket.receive(replay.frame);
    replaySocket.receive(recoveryComplete(replay.recoveryId, replay.revision, replay.stateDigest));
    await waitForLive(replayClient);

    expect(replayClient.getSnapshot().connection.phase).toBe("live");
    expect(replayClient.getSnapshot().canonical).toMatchObject({ revision: replay.revision, stateDigest: replay.stateDigest, state: { participants: replay.state.participants } });
    expect(sent(replaySocket).filter(isRecoveryAck)).toEqual([{ type: "recovery_ack", recovery_id: replay.recoveryId, revision: replay.revision, state_digest: replay.stateDigest }]);

    const snapshotSockets = new TestSockets();
    const snapshotClient = new SyncClient({
      url: "ws://sync.test/v2/sync",
      token: async () => "token",
      webSocket: snapshotSockets,
      codec: syncV2ProtocolCodec,
      clock: new TestClock(),
    });
    const snapshotState = snapshotStateWithParticipants(300);
    const snapshotDigest = await computeStateDigest(snapshotState, 1, stateSchemaVersion);
    const welcome = snapshotWelcome("00000000-0000-4000-8000-000000000003", clientParticipantId, snapshotState, 1, snapshotDigest);

    expect(encodedSyncFrameBytes(welcome)).toBeGreaterThan(SyncProtocolLimits.decodedInboundFrameBytes);
    expect(encodedSyncFrameBytes(welcome)).toBeLessThanOrEqual(SyncProtocolLimits.snapshotEncodedBytes);
    await snapshotClient.start();
    const snapshotSocket = snapshotSockets.latest();
    snapshotSocket.open();
    await settle();
    snapshotSocket.receive(welcome);
    snapshotSocket.receive(recoveryComplete("00000000-0000-4000-8000-000000000003", 1, snapshotDigest));
    await waitForLive(snapshotClient);

    expect(snapshotClient.getSnapshot().connection.phase).toBe("live");
    expect(snapshotClient.getSnapshot().canonical).toMatchObject({ revision: 1, stateDigest: snapshotDigest, state: { participants: snapshotState.participants } });
    expect(sent(snapshotSocket).filter(isRecoveryAck)).toEqual([{ type: "recovery_ack", recovery_id: "00000000-0000-4000-8000-000000000003", revision: 1, state_digest: snapshotDigest }]);
  });
});

class FailingPendingStore implements PendingCommandStore {
  async load(): Promise<readonly PendingCommand[]> {
    return [];
  }

  async put(): Promise<void> {
    throw new Error("storage failure");
  }

  async remove(): Promise<void> {}
}

class FlakyLoadPendingStore implements PendingCommandStore {
  loadCalls = 0;

  constructor(readonly command: PendingCommand) {}

  async load(): Promise<readonly PendingCommand[]> {
    this.loadCalls += 1;
    if (this.loadCalls === 1) {
      throw new Error("storage temporarily unavailable");
    }
    return [this.command];
  }

  async put(): Promise<void> {}

  async remove(): Promise<void> {}
}

class FlakyRemovePendingStore implements PendingCommandStore {
  removeCalls = 0;
  readonly #commands = new Map<string, PendingCommand>();

  constructor(command: PendingCommand) {
    this.#commands.set(command.commandId, command);
  }

  async load(): Promise<readonly PendingCommand[]> {
    return [...this.#commands.values()];
  }

  async put(command: PendingCommand): Promise<void> {
    this.#commands.set(command.commandId, command);
  }

  async remove(commandId: string): Promise<void> {
    this.removeCalls += 1;
    if (this.removeCalls === 1) {
      throw new Error("storage temporarily unavailable");
    }
    this.#commands.delete(commandId);
  }
}

class DeferredPutPendingStore implements PendingCommandStore {
  putCalls = 0;
  readonly #resolvers: Array<() => void> = [];

  async load(): Promise<readonly PendingCommand[]> {
    return [];
  }

  put(): Promise<void> {
    this.putCalls += 1;
    return new Promise((resolve) => this.#resolvers.push(resolve));
  }

  resolvePut(index: number): void {
    this.#resolvers[index]?.();
  }

  async remove(): Promise<void> {}
}

class DeferredLoadPendingStore implements PendingCommandStore {
  loadCalls = 0;
  readonly #resolvers: Array<(commands: readonly PendingCommand[]) => void> = [];

  load(): Promise<readonly PendingCommand[]> {
    this.loadCalls += 1;
    return new Promise((resolve) => {
      this.#resolvers.push(resolve);
    });
  }

  resolveLoad(index: number): void {
    this.#resolvers[index]?.([]);
  }

  async put(): Promise<void> {}

  async remove(): Promise<void> {}
}

class TestLifecycle {
  subscribeCalls = 0;
  unsubscribeCalls = 0;
  readonly #listeners = new Set<(event: "online" | "offline" | "active" | "inactive") => void>();

  get activeSubscriptions(): number {
    return this.#listeners.size;
  }

  subscribe(listener: (event: "online" | "offline" | "active" | "inactive") => void): () => void {
    this.subscribeCalls += 1;
    this.#listeners.add(listener);
    return () => {
      this.unsubscribeCalls += 1;
      this.#listeners.delete(listener);
    };
  }
}

class TestDocument extends EventTarget {
  constructor(public hidden: boolean) {
    super();
  }
}

async function startClientAtCommittedPendingRevision(store: PendingCommandStore, recoveryId: string): Promise<{ client: SyncClient; socket: ReturnType<TestSockets["latest"]> }> {
  const sockets = new TestSockets();
  const client = new SyncClient({
    url: "ws://sync.test/v2/sync",
    token: async () => "token",
    webSocket: sockets,
    codec: jsonSyncProtocolCodec,
    pendingStore: store,
    clock: new TestClock(),
  });
  const committedState: ControlState = { status: "active", participants: [{ participantSessionId, displayName: "Ada", handRaised: true }] };
  const committedDigest = await computeStateDigest(committedState, 2, stateSchemaVersion);

  await client.start();
  const socket = sockets.latest();
  socket.open();
  await settle();
  socket.receive({
    type: "welcome",
    protocol: 2,
    participantSessionId,
    participantSessionGeneration: 1,
    recoveryId,
    mode: "snapshot",
    head: { revision: 2, stateSchemaVersion, stateDigest: committedDigest },
    snapshot: { state: committedState, revision: 2, stateSchemaVersion, stateDigest: committedDigest },
  });
  socket.receive({ type: "recovery_complete", recoveryId, head: { revision: 2, stateSchemaVersion, stateDigest: committedDigest } });
  await settle();
  return { client, socket };
}

function uuid(value: number): string {
  return `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
}

function snapshotWelcome(recoveryId: string, participantId: string, state: ControlState, revision: number, stateDigest: string) {
  return {
    type: "welcome",
    protocol: 2,
    participant_session_id: participantId,
    participant_session_generation: 1,
    recovery_id: recoveryId,
    mode: "snapshot",
    head: { revision, state_schema_version: stateSchemaVersion, state_digest: stateDigest },
    snapshot: {
      control_revision: revision,
      state_schema_version: stateSchemaVersion,
      state_digest: stateDigest,
      status: state.status,
      participants: state.participants.map((participant) => ({ participant_session_id: participant.participantSessionId, display_name: participant.displayName, hand_raised: participant.handRaised })),
    },
  };
}

function recoveryComplete(recoveryId: string, revision: number, stateDigest: string) {
  return { type: "recovery_complete", recovery_id: recoveryId, head: { revision, state_schema_version: stateSchemaVersion, state_digest: stateDigest } };
}

async function replayPage(participantId: string) {
  const recoveryId = "00000000-0000-4000-8000-000000000004";
  let state: ControlState = { status: "active", participants: [] };
  const events = [];
  for (let index = 1; index <= 128; index += 1) {
    const participant = { participantSessionId: uuid(1_000 + index), displayName: "R".repeat(256), handRaised: false };
    state = { status: "active", participants: [...state.participants, participant] };
    const stateDigest = await computeStateDigest(state, index, stateSchemaVersion);
    events.push({
      type: "event",
      stream: "control",
      name: "participant_joined",
      event_id: uuid(2_000 + index),
      base_revision: index - 1,
      revision: index,
      schema_version: stateSchemaVersion,
      resulting_state_digest: stateDigest,
      payload: { display_name: participant.displayName, participant_session_id: participant.participantSessionId },
      lifecycle_intent_id: uuid(3_000 + index),
    });
  }
  const stateDigest = await computeStateDigest(state, events.length, stateSchemaVersion);
  const frame = { type: "replay_page", recovery_id: recoveryId, first_revision: 1, last_revision: events.length, events };
  return {
    recoveryId,
    frame,
    revision: events.length,
    stateDigest,
    state,
    welcome: {
      type: "welcome",
      protocol: 2,
      participant_session_id: participantId,
      participant_session_generation: 1,
      recovery_id: recoveryId,
      mode: "replay",
      head: { revision: events.length, state_schema_version: stateSchemaVersion, state_digest: stateDigest },
    },
  };
}

function snapshotStateWithParticipants(count: number): ControlState {
  return {
    status: "active",
    participants: Array.from({ length: count }, (_, index) => ({ participantSessionId: uuid(4_000 + index), displayName: "S".repeat(256), handRaised: false })),
  };
}

async function waitForLive(client: SyncClient): Promise<void> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    if (client.getSnapshot().connection.phase === "live") {
      return;
    }
    await new Promise<void>((resolve) => globalThis.setTimeout(resolve, 0));
  }
  throw new Error("client did not complete recovery");
}
