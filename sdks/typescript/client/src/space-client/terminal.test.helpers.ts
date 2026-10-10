import { expect, vi, type Mock } from "vitest";
import type { ConnectionSyncClient, ConnectionMediaFactoryInput } from "../connection/dependencies";
import type { V1ControlState } from "../sync/v1-types";
import { createSpaceClientForPlatform } from "./space-client";
import { createCoreTestPlatform, opaqueAccessGrant } from "./core.test.helpers";

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

export function terminalTestClient(platform: ReturnType<typeof terminalTestPlatform>): { client: ReturnType<typeof createSpaceClientForPlatform>; ended: Mock; error: Mock } {
  const client = createSpaceClientForPlatform({ space: "test", getAccess: async () => opaqueAccessGrant(1) }, platform);
  const ended = vi.fn();
  const error = vi.fn();
  client.on("episodeEnded", ended);
  client.on("error", error);
  return { client, ended, error };
}

export function expectAcknowledgedEnd(context: ReturnType<typeof terminalTestClient>, platform: ReturnType<typeof terminalTestPlatform>) {
  expect(context.client.getSnapshot().connection.status).toBe("left");
  expect(context.ended).toHaveBeenCalledOnce();
  expect(context.error).not.toHaveBeenCalled();
  expect(platform.stopped).toHaveBeenCalledOnce();
}

export function observeMicrophonePublication(platform: ReturnType<typeof createCoreTestPlatform>, track: MediaStreamTrack, options: { control?: V1ControlState; publicationId?: string } = {}) {
  const active = { participantId: "participant-1", source: "microphone" as const, enabled: true, publicationId: "old-publication" };
  platform.emitSync({ ...platform.sync.getSnapshot(), ...(options.control ? { control: options.control } : {}), media: { projectionId: "media-1", sequence: 1, items: [active] } });
  platform.media.emit({ ...platform.media.getSnapshot(), localTracks: [{ ...active, publicationId: options.publicationId ?? active.publicationId, track }] });
  return active;
}

export async function joinWithTerminalControl(client: ReturnType<typeof createSpaceClientForPlatform>, platform: ReturnType<typeof terminalTestPlatform>) {
  await client.join({ microphone: false, camera: false });
  platform.emitSync({ ...platform.sync.getSnapshot(), control });
  await vi.waitFor(() => expect(client.getSnapshot().participants.roster).toHaveLength(1));
}
