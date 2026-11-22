import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import admissionOrder from "../../test/fixtures/admission-order-v1.json";
import { SnapshotSchema } from "../generated/sync";
import { decodeV1ServerFrame } from "./v1-codec";
import { InMemoryV1PendingTargetStore } from "./v1-persistence";
import { applyV1Event, computeV1StateDigest, restoreV1Snapshot, snapshotToState } from "./v1-reducer";
import { commandIds, ownerId, peerId, recordingClient, recoverSocket, settle, stateWithPeer, syncClient, wireSnapshot } from "../../tests/helpers/sync-v1";
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
