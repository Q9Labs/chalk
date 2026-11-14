import { Effect } from "effect";
import { expect, it } from "vitest";

import type { ConnectionLifecycleCapability, ConnectionPorts } from "../connection";
import type { ConnectionSyncClient } from "../connection/dependencies";
import type { V1EpisodeSnapshot } from "../sync";
import { makeParticipantsController } from "./participants-controller";
import { SpaceStore } from "./store";

it("shows who can join and sends a host's change to Sync, refusing a policy the call cannot set", async () => {
  let policy: "open" | "knock" = "open";
  const listeners = new Set<() => void>();
  const sent: string[] = [];
  const sync = {
    getSnapshot: () => snapshotWithPolicy(policy),
    getParticipantCollaborationCapabilities: () => ({}),
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setAdmissionPolicy: async (next: "open" | "knock") => {
      sent.push(next);
      policy = next;
      for (const listener of listeners) listener();
    },
  } as unknown as ConnectionSyncClient;
  const ports = { sync, media: { getSnapshot: () => null, subscribe: () => () => undefined } } as unknown as ConnectionPorts;
  const connection = {
    getSnapshot: () => ({ state: "live", subject: null }),
    subscribePorts: (listener: (ports: ConnectionPorts | null) => void) => {
      listener(ports);
      return () => undefined;
    },
    runCommand: <A, E>(operation: (ports: ConnectionPorts) => Effect.Effect<A, E>) => operation(ports),
  } as unknown as ConnectionLifecycleCapability;
  const store = new SpaceStore();

  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const controller = yield* makeParticipantsController(connection, store);
        expect(store.getSnapshot().participants.admissionPolicy).toBe("open");

        yield* controller.setAdmissionPolicy("knock");
        expect(sent).toEqual(["knock"]);
        expect(store.getSnapshot().participants.admissionPolicy).toBe("knock");

        const refused = yield* Effect.result(controller.setAdmissionPolicy("members_only" as "open"));
        expect(refused._tag).toBe("Failure");
        if (refused._tag === "Failure") expect(refused.failure.code).toBe("participant.invalid");
        expect(sent).toEqual(["knock"]);
      }),
    ),
  );
});

function snapshotWithPolicy(admissionPolicy: "open" | "knock"): V1EpisodeSnapshot {
  const control = {
    revision: 1,
    stateSchemaVersion: 1,
    stateDigest: "digest",
    status: "active",
    admissionPolicy,
    deadlineAtMs: Date.now() + 60_000,
    deadlineGeneration: 1,
    roleCapabilities: { host: ["manageAdmission"] },
    recording: null,
    participants: [],
    admissionRequests: [],
  } as const;
  return {
    connection: { phase: "live" },
    participantId: "participant-1",
    participantGeneration: 1,
    control,
    optimisticControl: control,
    media: null,
    presence: null,
    mediaPlane: { local: [], remote: [] },
    localMedia: { microphone: "disabled", camera: "disabled", screen: "disabled" },
    pendingCommandCount: 0,
  };
}
