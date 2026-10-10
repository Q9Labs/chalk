import { vi } from "vitest";
import type { ConnectionSyncClient, ConnectionMediaFactoryInput } from "../connection/dependencies";
import type { V1ControlState } from "../sync/v1-types";
import { createCoreTestPlatform } from "./core.test.helpers";

export function terminalTestPlatform() {
  const platform = createCoreTestPlatform();
  const stopped = vi.fn<() => void>();
  const syncStopped = vi.fn<() => void>();
  const leave = vi.fn<ConnectionSyncClient["leave"]>().mockResolvedValue({ type: "ack", command_id: "leave", delivery: "original", outcome: "satisfied", revision: 2, state_digest: "digest" });
  const endEpisode = vi.fn<ConnectionSyncClient["endEpisode"]>(async () => {
    platform.emitSync({ ...platform.sync.getSnapshot(), control: { ...control, status: "ended", participants: [] } });
    return { type: "ack", command_id: "end", delivery: "original", outcome: "satisfied", revision: 2, state_digest: "digest" };
  });
  const sync = { ...platform.sync, stop: syncStopped, leave, endEpisode };
  const createMediaClient = platform.dependencies?.createMediaClient;
  const clock = platform.dependencies?.clock;
  if (!createMediaClient || !clock) throw new Error("The test platform must supply media and a clock");
  const dependencies = {
    ...platform.dependencies,
    clock,
    createSyncClient: () => sync,
    createMediaClient: (input: ConnectionMediaFactoryInput) => ({ ...createMediaClient(input), stop: stopped }),
  };
  return { ...platform, dependencies, stopped, syncStopped, leave, endEpisode };
}

export const control: V1ControlState = {
  revision: 1,
  stateSchemaVersion: 1,
  stateDigest: "digest",
  status: "active",
  admissionPolicy: "open",
  deadlineAtMs: Date.now() + 300_000,
  deadlineGeneration: 1,
  roleCapabilities: {},
  recording: null,
  admissionRequests: [],
  participants: [{ participantId: "participant-1", displayName: "Ada", handRaised: false, admissionRevision: 1, role: "owner", eligibleRoles: [], capabilities: ["endEpisode"] }],
};
