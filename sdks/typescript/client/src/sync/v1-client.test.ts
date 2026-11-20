import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import admissionOrder from "../../test/fixtures/admission-order-v1.json";
import { SnapshotSchema } from "../generated/sync";
import { decodeV1ServerFrame } from "./v1-codec";
import { V1SyncClient } from "./v1-client";
import { InMemoryV1PendingTargetStore } from "./v1-persistence";
import { applyV1Event, computeV1StateDigest, restoreV1Snapshot, snapshotToState } from "./v1-reducer";
import type { SyncSocket, SyncWebSocketFactory } from "./types";
import type { V1ControlState } from "./v1-types";
type Snapshot = typeof SnapshotSchema.Type;
const ownerId = "018f2f65-2a77-7a44-8e9a-5b0b6f8d4c21";
const peerId = "018f2f65-2a77-7a44-8e9a-5b0b6f8d4c22";
const recoveryId = "018f2f65-2a77-7a44-8e9a-5b0b6f8d4c23";
const projectionId = "018f2f65-2a77-7a44-8e9a-5b0b6f8d4c24";
const commandIds = Array.from({ length: 20 }, (_, index) => `018f2f65-2a77-7a44-8e9a-${(0x5b0b6f8d4d00 + index).toString(16)}`);
describe("V1SyncClient", () => {
  it.each(["live", "replay"] as const)("replaces a %s digest mismatch with one snapshot before durable replay", async (source) => {
    const { client, clock, sockets } = recordingClient({ reconnectDelayMs: 1 });
    // B1's second knock arrived after a larger request ID. The old server hashed
    // sorted IDs while the client hashed arrival order (the retained #382 fixture).
    const initial = await restoreV1Snapshot(Schema.decodeUnknownSync(SnapshotSchema)(admissionOrder.initial_snapshot));
    const firstKnock = decodeV1ServerFrame(JSON.stringify(admissionOrder.events[0]));
    const secondKnock = decodeV1ServerFrame(JSON.stringify(admissionOrder.events[1]));
    if (firstKnock.type !== "event" || secondKnock.type !== "event") throw new Error("Expected admission events");
    const state = await applyV1Event(initial, firstKnock);
    const snapshot = await wireSnapshot(state);
    const recoveredState = await applyV1Event(state, secondKnock);
    const recoveredSnapshot = await wireSnapshot(recoveredState);
    const badEvent = { ...secondKnock, resulting_state_digest: admissionOrder.legacy_resulting_state_digests[1] };
    await client.start();
    sockets[0]!.open();
    await settle();
    await recoverSocket(client, sockets[0]!, state, snapshot, "snapshot");
    if (source === "replay") {
      sockets[0]!.close();
      clock.advance(0);
      await settle();
      clock.advance(1);
      sockets[1]!.open();
      await settle();
      sockets[1]!.receive({ type: "welcome", protocol: 1, participant_id: ownerId, participant_generation: 1, recovery_id: recoveryId, mode: "replay", head: { revision: 2, state_schema_version: 1, state_digest: badEvent.resulting_state_digest } });
      sockets[1]!.receive({ type: "replay_page", recovery_id: recoveryId, first_revision: 2, last_revision: 2, events: [badEvent] });
    } else sockets[0]!.receive(badEvent);
    await settle();
    clock.advance(2);
    const recovery = sockets.at(-1)!;
    recovery.open();
    await settle();
    expect(recovery.frames()[0]).toMatchObject({ type: "hello", streams: { control: { cursor: null } } });
    const pending = client.setHandRaised(true, { commandId: commandIds[0] });
    void pending.catch(() => {});
    expect(recovery.frames().some((frame) => frame.type === "command")).toBe(false);
    await recoverSocket(client, recovery, recoveredState, recoveredSnapshot, "snapshot");
    expect(client.getSnapshot().control?.admissionRequests.map((request) => request.displayName)).toEqual(["First", "Second"]);
    expect(recovery.frames().filter((frame) => frame.type === "command")).toHaveLength(1);
    const count = sockets.length;
    recovery.receive({ ...admissionOrder.events[2], resulting_state_digest: admissionOrder.legacy_resulting_state_digests[2] });
    await settle();
    expect(client.getSnapshot().connection).toMatchObject({ phase: "terminal", terminalReason: "state_digest_recovery_failed" });
    clock.advance(60000);
    await settle();
    expect(sockets).toHaveLength(count);
  });
  it.each([
    { receiptTiming: "before", outcome: "committed" },
    { receiptTiming: "after", outcome: "committed" },
    { receiptTiming: "before", outcome: "satisfied" },
    { receiptTiming: "after", outcome: "satisfied" },
  ] as const)("reconciles older $outcome receipts received $receiptTiming the forced snapshot", async ({ receiptTiming, outcome }) => {
    const store = new InMemoryV1PendingTargetStore();
    const { client, clock, sockets } = recordingClient({ pendingStore: store, reconnectDelayMs: 1 });
    const initial = stateWithPeer("collaborator");
    const snapshot = await wireSnapshot(initial);
    const committed = { ...initial, revision: 2, participants: initial.participants.map((participant) => ({ ...participant, handRaised: participant.participantId === ownerId })) };
    const committedDigest = await computeV1StateDigest(committed);
    // Another participant advances the authoritative head beyond the receipt.
    const authoritative = { ...committed, revision: 3, participants: committed.participants.map((participant) => ({ ...participant, handRaised: true })) };
    const authoritativeSnapshot = await wireSnapshot(authoritative);
    let result: unknown;
    await client.start();
    sockets[0]!.open();
    await settle();
    await recoverSocket(client, sockets[0]!, snapshotToState(snapshot), snapshot, "snapshot");
    const command = client.setHandRaised(true, { commandId: commandIds[0] });
    void command.then(
      (value) => {
        result = value;
      },
      () => {},
    );
    const rejected = client.setDisplayName("Rejected", { commandId: commandIds[1] }).catch((error: unknown) => error);
    await settle();
    const receipt = { type: "ack", command_id: commandIds[0], delivery: "duplicate", outcome, ...(outcome === "committed" ? { event_id: recoveryId } : {}), revision: 2, state_digest: committedDigest };
    if (receiptTiming === "before") {
      sockets[0]!.receive(receipt);
      await settle();
      expect(result).toBeUndefined();
    }
    sockets[0]!.receive({ type: "event", stream: "control", name: "hand_raised", event_id: recoveryId, base_revision: 1, revision: 2, schema_version: 1, resulting_state_digest: "a".repeat(64), payload: { participant_id: ownerId }, command_id: commandIds[0] });
    await settle();
    clock.advance(1);
    sockets[1]!.open();
    await settle();
    await recoverSocket(client, sockets[1]!, snapshotToState(authoritativeSnapshot), authoritativeSnapshot, "snapshot");
    if (receiptTiming === "after") sockets[1]!.receive(receipt);
    sockets[1]!.receive({ type: "ack", command_id: commandIds[1], delivery: "duplicate", outcome: "rejected", reason: "external_operation_failed" });
    await settle();
    expect(result).toMatchObject({ outcome, revision: 2, state_digest: committedDigest });
    await expect(rejected).resolves.toMatchObject({ code: "rejected" });
    expect(await store.load()).toEqual([]);
    expect(client.getSnapshot()).toMatchObject({
      pendingCommandCount: 0,
      control: {
        revision: 3,
        participants: [
          { participantId: ownerId, handRaised: true },
          { participantId: peerId, handRaised: true },
        ],
      },
    });
    expect(sockets[1]!.frames().filter((frame) => frame.type === "command" && frame.command_id === commandIds[0])).toHaveLength(receiptTiming === "before" ? 0 : 1);
    sockets[1]!.close();
    clock.advance(0);
    await settle();
    clock.advance(1);
    sockets[2]!.open();
    await settle();
    await recoverSocket(client, sockets[2]!, snapshotToState(authoritativeSnapshot), authoritativeSnapshot, "up_to_date");
    expect(sockets[2]!.frames().filter((frame) => frame.type === "command")).toEqual([]);
    let unprovenSettled = false;
    for (const [index, revision] of [3, 4].entries()) {
      const pending = client.setHandRaised(false, { commandId: commandIds[index + 2] });
      void pending.then(
        () => {
          unprovenSettled = true;
        },
        () => {},
      );
      await settle();
      sockets[2]!.receive({ type: "ack", command_id: commandIds[index + 2], delivery: "duplicate", outcome: "satisfied", revision, state_digest: "f".repeat(64) });
    }
    await settle();
    expect(unprovenSettled).toBe(false);
    expect(await store.load()).toHaveLength(2);
  });
});
type ClientOptions = Partial<ConstructorParameters<typeof V1SyncClient>[0]>;
function syncClient(options: ClientOptions = {}): V1SyncClient {
  return new V1SyncClient({ url: "ws://sync.test/v1/sync", token: async () => "token", webSocket: { connect: () => new TestSocket() }, ...options });
}
function recordingClient(options: ClientOptions = {}) {
  const clock = new TestClock();
  const sockets: TestSocket[] = [];
  const client = syncClient({ clock, webSocket: collectSockets(sockets), ...options });
  return { client, clock, sockets };
}
function collectSockets(sockets: TestSocket[]): SyncWebSocketFactory {
  return {
    connect: () => {
      const socket = new TestSocket();
      sockets.push(socket);
      return socket;
    },
  };
}
async function recoverSocket(client: V1SyncClient, socket: TestSocket, state: V1ControlState, snapshot: Snapshot, mode: "snapshot" | "up_to_date", entryConfirmation = true, entryGeneration?: number, mediaOffReason = false, connectionQuality = false): Promise<void> {
  const recoveryAcks = () => socket.frames().filter((frame) => frame.type === "recovery_ack").length;
  const acksBefore = recoveryAcks();
  socket.receive({
    type: "welcome",
    protocol: 1,
    participant_id: ownerId,
    participant_generation: 1,
    recovery_id: recoveryId,
    head: { revision: state.revision, state_schema_version: state.stateSchemaVersion, state_digest: state.stateDigest },
    mode,
    ...(mode === "snapshot" ? { snapshot } : {}),
    ...(entryConfirmation ? { entry_confirmation: true } : {}),
    ...(entryGeneration === undefined ? {} : { entry_generation: entryGeneration }),
    ...(mediaOffReason ? { media_off_reason: true } : {}),
    ...(connectionQuality ? { connection_quality: true } : {}),
  });
  socket.receive({ type: "projection_snapshot", stream: "media", projection_id: projectionId, sequence: 0, items: [] });
  socket.receive({ type: "projection_snapshot", stream: "presence", projection_id: projectionId, sequence: 0, items: [] });
  socket.receive({ type: "recovery_complete", recovery_id: recoveryId, head: { revision: state.revision, state_schema_version: state.stateSchemaVersion, state_digest: state.stateDigest } });
  for (let attempt = 0; attempt < 50 && client.getSnapshot().connection.phase !== "live"; attempt += 1) await settle();
  expect(client.getSnapshot().connection.phase).toBe("live");
  // Sync reserves a recovery acknowledgement only for snapshots and closes the socket on an unexpected one.
  expect(recoveryAcks() - acksBefore).toBe(mode === "snapshot" ? 1 : 0);
}
function baseState(): V1ControlState {
  return {
    revision: 1,
    stateSchemaVersion: 1,
    stateDigest: "0".repeat(64),
    status: "active",
    admissionPolicy: "open",
    deadlineAtMs: 99999,
    deadlineGeneration: 1,
    roleCapabilities: { owner: ["publishAudio", "subscribe", "endEpisode"], collaborator: ["publishAudio"], observer: ["subscribe"] },
    recording: null,
    participants: [{ participantId: ownerId, displayName: "Owner", handRaised: false, admissionRevision: 1, role: "owner", eligibleRoles: ["owner"], capabilities: ["publishAudio", "subscribe", "endEpisode"] }],
    admissionRequests: [],
  };
}
function stateWithPeer(role: "collaborator" | "observer"): V1ControlState {
  const state = baseState();
  return {
    ...state,
    participants: [
      ...state.participants,
      {
        participantId: peerId,
        displayName: "Peer",
        handRaised: false,
        admissionRevision: 2,
        role,
        eligibleRoles: [role],
        capabilities: [...state.roleCapabilities[role]],
      },
    ],
  };
}
async function wireSnapshot(initial: V1ControlState): Promise<Snapshot> {
  const state = { ...initial, stateDigest: await computeV1StateDigest(initial) };
  return {
    control_revision: state.revision,
    state_schema_version: state.stateSchemaVersion,
    state_digest: state.stateDigest,
    status: state.status,
    admission_policy: state.admissionPolicy,
    deadline_at_ms: state.deadlineAtMs,
    deadline_generation: state.deadlineGeneration,
    role_capabilities: state.roleCapabilities,
    recording: null,
    participants: state.participants.map((participant) => ({
      participant_id: participant.participantId,
      display_name: participant.displayName,
      hand_raised: participant.handRaised,
      admission_revision: participant.admissionRevision,
      role: participant.role,
      capabilities: participant.capabilities,
    })),
    admission_requests: state.admissionRequests.map((request) => ({ admission_request_id: request.admissionRequestId, participant_id: request.participantId, display_name: request.displayName, role: request.initialRole, expires_at_ms: request.expiresAtMs })),
  };
}
class TestSocket implements SyncSocket {
  onopen: (() => void) | null = null;
  onmessage: ((event: { readonly data: unknown }) => void) | null = null;
  onclose: SyncSocket["onclose"] = null;
  onerror: (() => void) | null = null;
  readonly closeCalls: {
    readonly code: number;
    readonly reason: string | undefined;
  }[] = [];
  readonly sent: string[] = [];
  send(data: string): void {
    this.sent.push(data);
  }
  close(code = 1000, reason?: string): void {
    this.closeCalls.push({ code, reason });
    this.onclose?.({ code, reason });
  }
  error(): void {
    this.onerror?.();
  }
  open(): void {
    this.onopen?.();
  }
  receive(frame: unknown): void {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
  frames(): Record<string, unknown>[] {
    return this.sent.map((frame) => JSON.parse(frame));
  }
}
class TestClock {
  #now = 0;
  #nextHandle = 0;
  readonly #timers = new Map<
    number,
    {
      readonly at: number;
      readonly callback: () => void;
    }
  >();
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
async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}
