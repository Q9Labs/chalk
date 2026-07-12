import { Deferred, Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { createBrowserSyncLifecycle } from "./browser";
import { computeStateDigest } from "./canonical";
import { SyncPersistenceError } from "./index";
import { InMemoryPendingCommandStore, type PendingCommandStore } from "./persistence";
import { syncV2ProtocolCodec } from "./v2-codec";
import { SyncProtocolLimits, encodedSyncFrameBytes } from "../generated/sync-v2";
import { event, ids, isDeliveryAck, isRecoveryAck, makeSyncHarness, participantSessionId, sent, setHand, stateSchemaVersion, type ScriptedSocket, type SyncHarness, type SyncHarnessOptions } from "./test-support";
import type { ControlState, PendingCommand, SyncLifecycle } from "./types";

const harnesses: SyncHarness[] = [];

afterEach(async () => {
  await Promise.all(harnesses.splice(0).map((harness) => harness.dispose()));
});

function syncHarness(options: SyncHarnessOptions = {}): SyncHarness {
  const harness = makeSyncHarness(options);
  harnesses.push(harness);
  return harness;
}

describe("SyncClient", () => {
  it("reconciles ACK-before-event and event-before-ACK while retaining retryable pending work", async () => {
    const harness = syncHarness({ ids: ids("command-00000001", "command-00000002", "command-00000003"), token: "top-secret-token" });
    const { engine, transport } = harness;

    await harness.run(engine.start());
    const socket = transport.latest();
    socket.open();
    await harness.settle();
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
    await harness.settle();
    expect(engine.getSnapshot().connection.phase).toBe("live");

    const raiseId = await harness.run(engine.send({ name: "raise_hand" }));
    expect(engine.getSnapshot().optimistic.participants[0]?.handRaised).toBe(true);
    socket.receive({ type: "ack", commandId: raiseId, result: "committed", eventId: "event-2", revision: 2 });
    await harness.settle();
    expect(engine.getSnapshot().pending.count).toBe(1);

    const raisedState = setHand(initialState, true);
    const raisedDigest = await computeStateDigest(raisedState, 2, stateSchemaVersion);
    socket.receive(event({ eventId: "event-2", name: "hand_raised", baseRevision: 1, revision: 2, commandId: raiseId, payload: { participantSessionId }, resultingStateDigest: raisedDigest }));
    await harness.settle();
    expect(engine.getSnapshot().pending.count).toBe(0);
    expect(engine.getSnapshot().canonical?.state.participants[0]?.handRaised).toBe(true);
    expect(sent(socket).filter(isDeliveryAck)).toEqual([{ type: "delivery_ack", stream: "control", revision: 2, stateDigest: raisedDigest }]);

    const lowerId = await harness.run(engine.send({ name: "lower_hand" }));
    const loweredState = setHand(raisedState, false);
    const loweredDigest = await computeStateDigest(loweredState, 3, stateSchemaVersion);
    socket.receive(event({ eventId: "event-3", name: "hand_lowered", baseRevision: 2, revision: 3, commandId: lowerId, payload: { participantSessionId }, resultingStateDigest: loweredDigest }));
    await harness.settle();
    socket.receive({ type: "ack", commandId: lowerId, result: "duplicate", eventId: "event-3", revision: 3 });
    await harness.settle();
    expect(engine.getSnapshot().pending.count).toBe(0);

    const retryId = await harness.run(engine.send({ name: "raise_hand" }));
    socket.receive({ type: "retryable_error", commandId: retryId, code: "dependency_unavailable" });
    await harness.settle();
    expect(engine.getSnapshot().pending.commands.map((command) => command.commandId)).toEqual([retryId]);
    socket.receive({ type: "ack", commandId: retryId, result: "rejected", reason: "invalid_state" });
    await harness.settle();
    expect(engine.getSnapshot().pending.count).toBe(0);
    expect(engine.getSnapshot().failures.at(-1)).toMatchObject({ commandId: retryId, kind: "terminal_rejection", reason: "invalid_state" });
    expect(JSON.stringify(engine.getDiagnostics())).not.toContain("top-secret-token");
    expect(JSON.stringify(engine.getDiagnostics())).not.toContain("Private Name");
  });

  it("acknowledges snapshot and replay only after applying their resulting state", async () => {
    const harness = syncHarness();
    const { engine, transport } = harness;
    const initialState: ControlState = { status: "active", participants: [{ participantSessionId, displayName: "Ada", handRaised: false }] };
    const initialDigest = await computeStateDigest(initialState, 1, stateSchemaVersion);

    await harness.run(engine.start());
    const initialSocket = transport.latest();
    initialSocket.open();
    await harness.settle();
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
    await harness.settle();
    expect(sent(initialSocket).filter(isRecoveryAck)).toEqual([{ type: "recovery_ack", recoveryId: "snapshot-1", revision: 1, stateDigest: initialDigest }]);

    await harness.run(engine.stop());
    await harness.run(engine.start());
    const recoverySocket = transport.latest();
    recoverySocket.open();
    await harness.settle();
    const raisedState = setHand(initialState, true);
    const raisedDigest = await computeStateDigest(raisedState, 2, stateSchemaVersion);
    recoverySocket.receive({ type: "welcome", protocol: 2, participantSessionId, participantSessionGeneration: 1, recoveryId: "replay-1", mode: "replay", head: { revision: 2, stateSchemaVersion, stateDigest: raisedDigest } });
    recoverySocket.receive({ type: "replay_page", recoveryId: "replay-1", firstRevision: 2, lastRevision: 2, events: [event({ eventId: "event-2", name: "hand_raised", baseRevision: 1, revision: 2, payload: { participantSessionId }, resultingStateDigest: raisedDigest })] });
    recoverySocket.receive({ type: "recovery_complete", recoveryId: "replay-1", head: { revision: 2, stateSchemaVersion, stateDigest: raisedDigest } });
    await harness.settle();

    expect(sent(recoverySocket).filter(isDeliveryAck)).toEqual([]);
    expect(sent(recoverySocket).filter(isRecoveryAck)).toEqual([{ type: "recovery_ack", recoveryId: "replay-1", revision: 2, stateDigest: raisedDigest }]);
    expect(engine.getSnapshot().canonical?.revision).toBe(2);

    const loweredState = setHand(raisedState, false);
    const loweredDigest = await computeStateDigest(loweredState, 3, stateSchemaVersion);
    recoverySocket.receive(event({ eventId: "event-3", name: "hand_lowered", baseRevision: 2, revision: 3, payload: { participantSessionId }, resultingStateDigest: loweredDigest }));
    await harness.settle();
    expect(engine.getSnapshot().canonical).toMatchObject({ revision: 3, stateDigest: loweredDigest, state: loweredState });
    expect(sent(recoverySocket).filter(isDeliveryAck)).toEqual([{ type: "delivery_ack", stream: "control", revision: 3, stateDigest: loweredDigest }]);
  });

  it("does not acknowledge a snapshot whose digest fails validation", async () => {
    const harness = syncHarness();
    const { engine, transport } = harness;
    const state: ControlState = { status: "active", participants: [{ participantSessionId, displayName: "Ada", handRaised: false }] };
    const invalidDigest = "0".repeat(64);

    await harness.run(engine.start());
    const socket = transport.latest();
    socket.open();
    await harness.settle();
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
    await harness.settle();

    expect(sent(socket).filter(isRecoveryAck)).toEqual([]);
    expect(engine.getSnapshot().canonical).toBeNull();
  });

  it("clears a persisted command when snapshot recovery already contains its duplicate ACK revision", async () => {
    const commandId = "command-00000010";
    const store = new InMemoryPendingCommandStore([{ commandId, command: { name: "raise_hand" }, createdAt: 0, bytes: 1 }]);
    const { engine, socket, harness } = await startEngineAtCommittedPendingRevision(store, "snapshot-after-commit");

    expect(engine.getSnapshot().pending.count).toBe(1);
    expect(sent(socket)).toContainEqual({ type: "command", commandId, name: "raise_hand" });
    socket.receive({ type: "ack", commandId, result: "duplicate", eventId: "event-2", revision: 2 });
    await harness.settle();
    expect(engine.getSnapshot().pending.count).toBe(0);
    await expect(store.load()).resolves.toEqual([]);
  });

  it("retries durable cleanup when a settled command removal fails transiently", async () => {
    const commandId = "command-00000012";
    const command: PendingCommand = { commandId, command: { name: "raise_hand" }, createdAt: 0, bytes: 1 };
    const store = new FlakyRemovePendingStore(command);
    const { engine, socket, harness } = await startEngineAtCommittedPendingRevision(store, "snapshot-after-transient-cleanup-failure");
    const acknowledgement = { type: "ack", commandId, result: "duplicate", eventId: "event-2", revision: 2 } as const;

    socket.receive(acknowledgement);
    await harness.settle();
    expect(engine.getSnapshot().pending.count).toBe(1);
    expect(store.removeCalls).toBe(1);
    socket.receive(acknowledgement);
    await harness.settle();
    expect(engine.getSnapshot().pending.count).toBe(0);
    expect(store.removeCalls).toBe(2);
    await expect(store.load()).resolves.toEqual([]);
  });

  it("enforces local pending capacity and surfaces persisted expired work", async () => {
    const expired: PendingCommand = { commandId: "command-00000004", command: { name: "raise_hand" }, createdAt: -101, bytes: 42 };
    const harness = syncHarness({ ids: ids("command-00000005", "command-00000006"), pendingStore: new InMemoryPendingCommandStore([expired]), policy: { limits: { maxPendingCommands: 1, maxPendingBytes: 1_000, maxPendingAgeMs: 100 } } });
    const { engine } = harness;
    await harness.advance(101);

    await harness.run(engine.start());
    expect(engine.getSnapshot().failures).toContainEqual(expect.objectContaining({ commandId: expired.commandId, kind: "expired" }));
    await harness.run(engine.send({ name: "raise_hand" }));
    await expect(harness.run(engine.send({ name: "lower_hand" }))).rejects.toMatchObject({ name: "SyncCapacityError", limit: "count" });
  });

  it("reserves pending capacity before asynchronous persistence completes", async () => {
    const store = new DeferredPutPendingStore();
    const harness = syncHarness({ ids: ids("command-00000013", "command-00000014"), pendingStore: store, policy: { limits: { maxPendingCommands: 1, maxPendingBytes: 1_000, maxPendingAgeMs: 1_000 } } });
    const { engine } = harness;
    const first = harness.run(engine.send({ name: "raise_hand" }));

    expect(store.putCalls).toBe(1);
    await expect(harness.run(engine.send({ name: "lower_hand" }))).rejects.toMatchObject({ name: "SyncCapacityError", limit: "count" });
    expect(store.putCalls).toBe(1);
    store.resolvePut(0);
    await expect(first).resolves.toBe("command-00000013");
    expect(engine.getSnapshot().pending.count).toBe(1);
  });

  it("normalizes stored bytes and rejects oversized or nonempty generated payloads locally", async () => {
    const store = new InMemoryPendingCommandStore([{ commandId: "command-00000007", command: { name: "raise_hand" }, createdAt: 0, bytes: 1 }]);
    const harness = syncHarness({ ids: ids("command-00000008"), pendingStore: store, policy: { limits: { maxPendingCommands: 2, maxPendingBytes: 2, maxPendingAgeMs: 1_000 } } });
    const { engine } = harness;

    await harness.run(engine.start());
    expect(engine.getSnapshot().failures).toContainEqual(expect.objectContaining({ commandId: "command-00000007", kind: "capacity" }));
    await expect(harness.run(engine.send({ name: "lower_hand" }))).rejects.toMatchObject({ name: "SyncCapacityError", limit: "bytes" });
    await expect(harness.run(engine.send({ name: "raise_hand", payload: { unexpected: true } }))).rejects.toMatchObject({ name: "SyncCommandValidationError" });
  });

  it("does not apply optimistic state when persistence rejects a command", async () => {
    const harness = syncHarness({ ids: ids("command-00000001"), pendingStore: new FailingPendingStore() });
    const { engine } = harness;

    await expect(harness.run(engine.send({ name: "raise_hand" }))).rejects.toBeInstanceOf(SyncPersistenceError);
    expect(engine.getSnapshot().pending).toMatchObject({ count: 0, bytes: 0 });
  });

  it("retries the durable pending load after an initial storage failure", async () => {
    const command: PendingCommand = { commandId: "command-00000011", command: { name: "raise_hand" }, createdAt: 0, bytes: 1 };
    const store = new FlakyLoadPendingStore(command);
    const harness = syncHarness({ pendingStore: store });
    const { engine } = harness;

    await expect(harness.run(engine.start())).rejects.toThrow("unable to load pending sync commands");
    await harness.run(engine.start());
    expect(store.loadCalls).toBe(2);
    expect(engine.getSnapshot().pending.commands.map((pending) => pending.commandId)).toEqual([command.commandId]);
  });

  it("refreshes a token and reconnects after authentication requires rejoining", async () => {
    const harness = syncHarness({ token: "expired-token" });
    const { engine, transport } = harness;

    await harness.run(engine.start());
    const first = transport.latest();
    first.open();
    await harness.settle();
    expect(sent(first)[0]).toMatchObject({ type: "hello", token: "expired-token" });
    first.closeFromServer(1008);
    expect(engine.getSnapshot().connection).toEqual({ phase: "stopped", reason: "rejoin_required" });

    transport.setToken("fresh-token");
    await harness.run(engine.refresh());
    expect(transport.sockets).toHaveLength(2);
    const refreshed = transport.latest();
    refreshed.open();
    await harness.settle();
    expect(sent(refreshed)[0]).toMatchObject({ type: "hello", token: "fresh-token" });
    expect(engine.getSnapshot().connection.phase).toBe("recovering");
  });

  it("does not connect when browser lifecycle starts offline and hidden", async () => {
    const window = new EventTarget();
    const document = new TestDocument(true);
    const lifecycle = createBrowserSyncLifecycle({ window, document, navigator: { onLine: false } });
    const lifecycleEvents: string[] = [];
    const unsubscribe = lifecycle.subscribe((event) => lifecycleEvents.push(event));
    const harness = syncHarness({ lifecycle });
    const { engine, transport } = harness;

    await harness.run(engine.start());
    expect(lifecycleEvents).toEqual(["offline", "inactive"]);
    expect(transport.sockets).toEqual([]);
    unsubscribe();
  });

  it("does not install a lifecycle subscription after a stopped start finishes loading", async () => {
    const store = new DeferredLoadPendingStore();
    const lifecycle = new TestLifecycle();
    const harness = syncHarness({ lifecycle, pendingStore: store });
    const { engine, transport } = harness;
    const firstStart = harness.run(engine.start());

    expect(store.loadCalls).toBe(1);
    await harness.run(engine.stop());
    store.resolveLoad(0);
    await firstStart;
    expect(lifecycle.subscribeCalls).toBe(0);
    expect(lifecycle.activeSubscriptions).toBe(0);
    expect(transport.sockets).toEqual([]);

    await harness.run(engine.start());
    await harness.run(engine.start());
    expect(lifecycle.subscribeCalls).toBe(1);
    expect(lifecycle.activeSubscriptions).toBe(1);
    expect(transport.sockets).toHaveLength(1);
    await harness.run(engine.stop());
    expect(lifecycle.activeSubscriptions).toBe(0);
    expect(lifecycle.unsubscribeCalls).toBe(1);
  });

  it("keeps only the latest lifecycle subscription when a stopped start load finishes late", async () => {
    const store = new DeferredLoadPendingStore();
    const lifecycle = new TestLifecycle();
    const harness = syncHarness({ lifecycle, pendingStore: store });
    const { engine } = harness;
    const firstStart = harness.run(engine.start());
    await harness.run(engine.stop());
    const secondStart = harness.run(engine.start());

    expect(store.loadCalls).toBe(1);
    store.resolveLoad(0);
    await secondStart;
    await firstStart;
    expect(lifecycle.subscribeCalls).toBe(1);
    expect(lifecycle.activeSubscriptions).toBe(1);
  });

  it("accepts contract-valid replay and snapshot recovery frames above the command input cap", async () => {
    const replayHarness = syncHarness({ codec: syncV2ProtocolCodec });
    const { engine: replayEngine, transport: replayTransport } = replayHarness;
    const clientParticipantId = uuid(1);
    const emptyState: ControlState = { status: "active", participants: [] };
    const emptyDigest = await computeStateDigest(emptyState, 0, stateSchemaVersion);

    await replayHarness.run(replayEngine.start());
    const initialSocket = replayTransport.latest();
    initialSocket.open();
    await replayHarness.settle();
    initialSocket.receive(snapshotWelcome("00000000-0000-4000-8000-000000000002", clientParticipantId, emptyState, 0, emptyDigest));
    initialSocket.receive(recoveryComplete("00000000-0000-4000-8000-000000000002", 0, emptyDigest));
    await replayHarness.settle();
    await replayHarness.run(replayEngine.stop());

    await replayHarness.run(replayEngine.start());
    const replaySocket = replayTransport.latest();
    replaySocket.open();
    await replayHarness.settle();
    const replay = await replayPage(clientParticipantId);
    expect(encodedSyncFrameBytes(replay.frame)).toBeGreaterThan(SyncProtocolLimits.decodedInboundFrameBytes);
    expect(encodedSyncFrameBytes(replay.frame)).toBeLessThanOrEqual(SyncProtocolLimits.replayPageEncodedBytes);
    const replayLive = replayHarness.waitFor((snapshot) => snapshot.connection.phase === "live");
    replaySocket.receive(replay.welcome);
    replaySocket.receive(replay.frame);
    replaySocket.receive(recoveryComplete(replay.recoveryId, replay.revision, replay.stateDigest));
    await replayLive;

    expect(replayEngine.getSnapshot().connection.phase).toBe("live");
    expect(replayEngine.getSnapshot().canonical).toMatchObject({ revision: replay.revision, stateDigest: replay.stateDigest, state: { participants: replay.state.participants } });
    expect(sent(replaySocket).filter(isRecoveryAck)).toEqual([{ type: "recovery_ack", recovery_id: replay.recoveryId, revision: replay.revision, state_digest: replay.stateDigest }]);

    const snapshotHarness = syncHarness({ codec: syncV2ProtocolCodec });
    const { engine: snapshotEngine, transport: snapshotTransport } = snapshotHarness;
    const snapshotState = snapshotStateWithParticipants(300);
    const snapshotDigest = await computeStateDigest(snapshotState, 1, stateSchemaVersion);
    const welcome = snapshotWelcome("00000000-0000-4000-8000-000000000003", clientParticipantId, snapshotState, 1, snapshotDigest);
    expect(encodedSyncFrameBytes(welcome)).toBeGreaterThan(SyncProtocolLimits.decodedInboundFrameBytes);
    expect(encodedSyncFrameBytes(welcome)).toBeLessThanOrEqual(SyncProtocolLimits.snapshotEncodedBytes);
    await snapshotHarness.run(snapshotEngine.start());
    const snapshotSocket = snapshotTransport.latest();
    snapshotSocket.open();
    await snapshotHarness.settle();
    const snapshotLive = snapshotHarness.waitFor((snapshot) => snapshot.connection.phase === "live");
    snapshotSocket.receive(welcome);
    snapshotSocket.receive(recoveryComplete("00000000-0000-4000-8000-000000000003", 1, snapshotDigest));
    await snapshotLive;

    expect(snapshotEngine.getSnapshot().connection.phase).toBe("live");
    expect(snapshotEngine.getSnapshot().canonical).toMatchObject({ revision: 1, stateDigest: snapshotDigest, state: { participants: snapshotState.participants } });
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
  readonly #gates: Deferred.Deferred<void>[] = [];

  async load(): Promise<readonly PendingCommand[]> {
    return [];
  }

  put(): Promise<void> {
    this.putCalls += 1;
    const gate = Deferred.makeUnsafe<void>();
    this.#gates.push(gate);
    return Effect.runPromise(Deferred.await(gate));
  }

  resolvePut(index: number): void {
    const gate = this.#gates[index];
    if (gate) {
      Effect.runSync(Deferred.succeed(gate, undefined));
    }
  }

  async remove(): Promise<void> {}
}

class DeferredLoadPendingStore implements PendingCommandStore {
  loadCalls = 0;
  readonly #gates: Deferred.Deferred<readonly PendingCommand[]>[] = [];

  load(): Promise<readonly PendingCommand[]> {
    this.loadCalls += 1;
    const gate = Deferred.makeUnsafe<readonly PendingCommand[]>();
    this.#gates.push(gate);
    return Effect.runPromise(Deferred.await(gate));
  }

  resolveLoad(index: number): void {
    const gate = this.#gates[index];
    if (gate) {
      Effect.runSync(Deferred.succeed(gate, []));
    }
  }

  async put(): Promise<void> {}

  async remove(): Promise<void> {}
}

class TestLifecycle implements SyncLifecycle {
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

type StartedEngine = {
  readonly engine: SyncHarness["engine"];
  readonly harness: SyncHarness;
  readonly socket: ScriptedSocket;
};

async function startEngineAtCommittedPendingRevision(store: PendingCommandStore, recoveryId: string): Promise<StartedEngine> {
  const harness = syncHarness({ pendingStore: store });
  const { engine, transport } = harness;
  const committedState: ControlState = { status: "active", participants: [{ participantSessionId, displayName: "Ada", handRaised: true }] };
  const committedDigest = await computeStateDigest(committedState, 2, stateSchemaVersion);

  await harness.run(engine.start());
  const socket = transport.latest();
  socket.open();
  await harness.settle();
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
  await harness.settle();
  return { engine, harness, socket };
}

function uuid(value: number): string {
  return `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
}

function snapshotWelcome(recoveryId: string, participantId: string, state: ControlState, revision: number, stateDigest: string) {
  return {
    type: "welcome" as const,
    protocol: 2,
    participant_session_id: participantId,
    participant_session_generation: 1,
    recovery_id: recoveryId,
    mode: "snapshot" as const,
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
  return { type: "recovery_complete" as const, recovery_id: recoveryId, head: { revision, state_schema_version: stateSchemaVersion, state_digest: stateDigest } };
}

type ReplayEvent = {
  readonly type: "event";
  readonly stream: "control";
  readonly name: "participant_joined";
  readonly event_id: string;
  readonly base_revision: number;
  readonly revision: number;
  readonly schema_version: number;
  readonly resulting_state_digest: string;
  readonly payload: { readonly display_name: string; readonly participant_session_id: string };
  readonly lifecycle_intent_id: string;
};

type ReplayFrame = {
  readonly type: "replay_page";
  readonly recovery_id: string;
  readonly first_revision: number;
  readonly last_revision: number;
  readonly events: readonly ReplayEvent[];
};

type ReplayFixture = {
  readonly frame: ReplayFrame;
  readonly recoveryId: string;
  readonly revision: number;
  readonly state: ControlState;
  readonly stateDigest: string;
  readonly welcome: {
    readonly type: "welcome";
    readonly protocol: number;
    readonly participant_session_id: string;
    readonly participant_session_generation: number;
    readonly recovery_id: string;
    readonly mode: "replay";
    readonly head: { readonly revision: number; readonly state_schema_version: number; readonly state_digest: string };
  };
};

async function replayPage(participantId: string): Promise<ReplayFixture> {
  const recoveryId = "00000000-0000-4000-8000-000000000004";
  let state: ControlState = { status: "active", participants: [] };
  const events = [];
  for (let index = 1; index <= 128; index += 1) {
    const participant = { participantSessionId: uuid(1_000 + index), displayName: "R".repeat(256), handRaised: false };
    state = { status: "active", participants: [...state.participants, participant] };
    const stateDigest = await computeStateDigest(state, index, stateSchemaVersion);
    events.push({
      type: "event" as const,
      stream: "control" as const,
      name: "participant_joined" as const,
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
  const frame = replayFrame(recoveryId, events);
  return {
    recoveryId,
    frame,
    revision: events.length,
    stateDigest,
    state,
    welcome: { type: "welcome", protocol: 2, participant_session_id: participantId, participant_session_generation: 1, recovery_id: recoveryId, mode: "replay", head: { revision: events.length, state_schema_version: stateSchemaVersion, state_digest: stateDigest } },
  };
}

function replayFrame(recoveryId: string, events: readonly ReplayEvent[]): ReplayFrame {
  const first = events[0];
  const last = events.at(-1);
  if (!first || !last) {
    throw new Error("replay frame requires events");
  }
  return { type: "replay_page" as const, recovery_id: recoveryId, first_revision: first.revision, last_revision: last.revision, events };
}

function snapshotStateWithParticipants(count: number): ControlState {
  return { status: "active", participants: Array.from({ length: count }, (_, index) => ({ participantSessionId: uuid(4_000 + index), displayName: "S".repeat(256), handRaised: false })) };
}
