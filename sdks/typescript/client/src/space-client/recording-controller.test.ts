import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import type { ConnectionLifecycleCapability, ConnectionLifecycleSnapshot, ConnectionPorts } from "../connection";
import type { ConnectionSyncClient } from "../connection/dependencies";
import type { V1EpisodeSnapshot } from "../sync";
import { makeRecordingController } from "./recording-controller";
import { SpaceStore } from "./store";

describe("RecordingController", () => {
  it("projects optimistic recording state and sends authorized start and stop commands", async () => {
    let syncSnapshot = snapshotWithRecording(null);
    const syncListeners = new Set<(snapshot: V1EpisodeSnapshot) => void>();
    const stoppedRecordingIds: string[] = [];
    let startCount = 0;
    const sync = {
      getSnapshot: () => syncSnapshot,
      subscribe: (listener: (snapshot: V1EpisodeSnapshot) => void) => {
        syncListeners.add(listener);
        listener(syncSnapshot);
        return () => syncListeners.delete(listener);
      },
      startRecording: async () => {
        startCount += 1;
        return { recordingId: "recording-new", result: commandResult() };
      },
      stopRecording: async (recordingId: string) => {
        stoppedRecordingIds.push(recordingId);
        return commandResult();
      },
    } as unknown as ConnectionSyncClient;
    const ports = { sync } as ConnectionPorts;
    const connection = {
      subscribePorts: (listener: (ports: ConnectionPorts | null) => void) => {
        listener(ports);
        return () => undefined;
      },
      runCommand: <A, E>(operation: (ports: ConnectionPorts) => Effect.Effect<A, E>) => operation(ports),
    } as unknown as ConnectionLifecycleCapability;
    const store = new SpaceStore();
    store.updateConnection({ state: "live", episode: { id: "episode-1", startedAt: null, deadline: null }, failure: null } as ConnectionLifecycleSnapshot);

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const controller = yield* makeRecordingController(connection, store);

          const denied = yield* Effect.result(controller.start());
          expect(denied._tag).toBe("Failure");
          if (denied._tag === "Failure") expect(denied.failure.code).toBe("command.rejected");
          expect(startCount).toBe(0);

          store.updateSelf({ participantId: "participant-1", displayName: "A Participant", role: "facilitator", capabilities: ["manageRecording"], handRaised: false, can: (capability) => capability === "manageRecording" });
          expect(yield* controller.start()).toEqual({ recordingId: "recording-new" });
          expect(startCount).toBe(1);

          syncSnapshot = snapshotWithRecording({ recordingId: "recording-live", status: "recording", failureCode: null });
          for (const listener of syncListeners) listener(syncSnapshot);
          expect(store.getSnapshot().recording.current).toEqual({ recordingId: "recording-live", status: "recording", failureCode: null });

          yield* controller.stop();
          expect(stoppedRecordingIds).toEqual(["recording-live"]);

          syncSnapshot = {
            ...syncSnapshot,
            optimisticControl: {
              ...syncSnapshot.control!,
              recording: { recordingId: "recording-live", status: "stopping", failureCode: null },
            },
          };
          for (const listener of syncListeners) listener(syncSnapshot);
          expect(store.getSnapshot().recording.current?.status).toBe("stopping");
        }),
      ),
    );
  });
});

function snapshotWithRecording(recording: NonNullable<NonNullable<V1EpisodeSnapshot["control"]>["recording"]> | null): V1EpisodeSnapshot {
  const control = {
    revision: 1,
    stateSchemaVersion: 1,
    stateDigest: "digest",
    status: "active",
    admissionPolicy: "open",
    deadlineAtMs: Date.now() + 60_000,
    deadlineGeneration: 1,
    roleCapabilities: { facilitator: ["manageRecording"] },
    recording,
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

function commandResult(): Awaited<ReturnType<ConnectionSyncClient["stopRecording"]>> {
  return { type: "ack", command_id: "command-1", outcome: "satisfied", revision: 1, state_digest: "digest" };
}
