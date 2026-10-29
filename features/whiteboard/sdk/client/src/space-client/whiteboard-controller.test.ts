import { Effect } from "effect";
import { expect, it, vi } from "vitest";
import type { ConnectionLifecycleCapability, ConnectionPorts } from "../connection";
import type { ChalkWhiteboardV1Transport } from "../whiteboard/types";
import { makeWhiteboardController } from "./whiteboard-controller";
import { SpaceStore } from "./store";
import type { Participant } from "./types";

it("clears departed participants but retains view history through temporary socket loss", async () => {
  const store = new SpaceStore();
  const person: Participant = {
    participantId: "person",
    displayName: "Person",
    role: "member",
    eligibleRoles: [],
    capabilities: [],
    handRaised: false,
    media: { microphone: "inactive", camera: "inactive", screenShare: "inactive" },
    presence: { state: "connected", speaking: false, activeSpeaker: false },
  };
  store.updateParticipants({ roster: [person], admissionQueue: [] });
  const forgetParticipant = vi.fn();
  const stopSceneSubscription = vi.fn();
  const transport = { forgetParticipant, stopSceneSubscription } as unknown as ChalkWhiteboardV1Transport;
  let portsChanged: (ports: ConnectionPorts | null) => void = () => {};
  const connection = {
    subscribePorts: (listener: typeof portsChanged) => {
      portsChanged = listener;
      listener(null);
      return () => {};
    },
  } as unknown as ConnectionLifecycleCapability;
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        yield* makeWhiteboardController(connection, store, () => transport);
        portsChanged(null);
        store.updateParticipants({ roster: [{ ...person, presence: { ...person.presence, state: "disconnected" } }], admissionQueue: [] });
        expect(forgetParticipant).not.toHaveBeenCalled();
        store.updateParticipants({ roster: [], admissionQueue: [] });
        expect(forgetParticipant).toHaveBeenCalledExactlyOnceWith("person");
      }),
    ),
  );
  store.updateParticipants({ roster: [person], admissionQueue: [] });
  store.updateParticipants({ roster: [], admissionQueue: [] });
  expect(forgetParticipant).toHaveBeenCalledTimes(1);
});

it("does not turn a temporarily unavailable control replica into participant departures", async () => {
  const { makeParticipantsController } = await import("./participants-controller");
  const person = { participantId: "owner", displayName: "Owner", role: "host", eligibleRoles: [], capabilities: [], handRaised: false };
  let snapshot: { participantId: string; control: { participants: (typeof person)[]; admissionRequests: [] } | null; optimisticControl: null; media: null; presence: null } = {
    participantId: "owner",
    control: { participants: [person], admissionRequests: [] },
    optimisticControl: null,
    media: null,
    presence: null,
  };
  const observers = new Set<() => void>();
  const ports = {
    sync: {
      getSnapshot: () => snapshot,
      getParticipantCollaborationCapabilities: () => ({}),
      subscribe: (listener: () => void) => {
        observers.add(listener);
        return () => observers.delete(listener);
      },
    },
    media: { getSnapshot: () => ({ remoteTracks: [], localTracks: [] }), subscribe: () => () => {} },
  } as unknown as ConnectionPorts;
  const connection = {
    subscribePorts: (listener: (ports: ConnectionPorts) => void) => {
      listener(ports);
      return () => {};
    },
  } as unknown as ConnectionLifecycleCapability;
  const forgetParticipant = vi.fn();
  const transport = { forgetParticipant, stopSceneSubscription: () => {} } as unknown as ChalkWhiteboardV1Transport;
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const store = new SpaceStore();
        yield* makeParticipantsController(connection, store);
        yield* makeWhiteboardController(connection, store, () => transport);
        const control = snapshot.control;
        snapshot = { ...snapshot, control: null };
        for (const notify of observers) notify();
        expect(store.getSnapshot().participants.roster.map((p) => p.participantId)).toEqual(["owner"]);
        expect(forgetParticipant).not.toHaveBeenCalled();
        snapshot = { ...snapshot, control };
        for (const notify of observers) notify();
        expect(forgetParticipant).not.toHaveBeenCalled();
        snapshot = { ...snapshot, control: { participants: [], admissionRequests: [] } };
        for (const notify of observers) notify();
        expect(forgetParticipant).toHaveBeenCalledExactlyOnceWith("owner");
      }),
    ),
  );
});
