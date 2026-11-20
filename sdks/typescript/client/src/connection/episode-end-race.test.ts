import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CloudflareSFUError } from "../media";
import type { ConnectionDependencies, ConnectionMediaFactoryInput } from "./dependencies";
import { createCoreTestPlatform, opaqueAccessGrant } from "../space-client/core.test.helpers";
import { createSpaceClientForPlatform } from "../space-client/space-client";
import type { V1ControlState } from "../sync/v1-types";

beforeEach(() => vi.stubGlobal("fetch", async () => new Response(null, { status: 204 })));
afterEach(() => vi.unstubAllGlobals());

describe("Episode end wins media rejection", () => {
  // Sanitized production ordering: guest publications GET 403 at 22:23:26.369,
  // media.end_episode completes at 22:23:32.540; provider close_tracks returns 410.
  // The Sync replica is still active at the rejection, not already ended.
  it("ends cleanly before Sync sees the end after a provider rejects the credential", async () => {
    const test = fixture("ending");
    try {
      await test.join();
      test.reject(new CloudflareSFUError("SFU request rejected during teardown", "signaling_failed", { status: 403 }));
      await vi.waitFor(() => expect(test.client.getSnapshot().connection.status).toBe("left"));
      expect(test.platform.sync.getSnapshot().control?.status).toBe("active");
      expect(test.events.ended).toHaveLength(1);
      expect(test.events.errors).toEqual([]);
      expect(test.client.getSnapshot().connection.lastError).toBeNull();
      test.endEvent();
      expect(test.events.ended).toHaveLength(1);
    } finally {
      test.client.dispose();
    }
  });

  it("rejects a revoked credential while the Episode is still active", async () => {
    const test = fixture();
    try {
      await test.join();
      test.reject(new CloudflareSFUError("Revoked media credential", "signaling_failed", { status: 403 }));
      await vi.waitFor(() => expect(test.client.getSnapshot().connection.status).toBe("failed"));
      expect(test.client.getSnapshot().connection.lastError).toMatchObject({ code: "access.invalid", recoverable: false });
      expect(test.events.ended).toEqual([]);
    } finally {
      test.client.dispose();
    }
  });
});

const control: V1ControlState = {
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

function fixture(episodeStatus: "active" | "ending" = "active") {
  const base = createCoreTestPlatform();
  const status: NonNullable<ConnectionDependencies["getEpisodeStatus"]> = async () => episodeStatus;
  let onFailure: ConnectionMediaFactoryInput["onFailure"] = () => {};
  const platform = {
    ...base,
    dependencies: {
      ...base.dependencies,
      getEpisodeStatus: status,
      createMediaClient: (input: ConnectionMediaFactoryInput) => {
        onFailure = input.onFailure;
        return base.dependencies.createMediaClient(input);
      },
    },
  };
  const client = createSpaceClientForPlatform({ space: "test", getAccess: async () => opaqueAccessGrant(1) }, platform);
  const events = { ended: [] as unknown[], errors: [] as unknown[] };
  client.on("episodeEnded", (event) => events.ended.push(event));
  client.on("error", (event) => events.errors.push(event));
  return {
    platform,
    client,
    events,
    join: async () => {
      await client.join({ microphone: false, camera: false });
      platform.emitSync({ ...platform.sync.getSnapshot(), control });
      await vi.waitFor(() => expect(client.getSnapshot().participants.roster).toHaveLength(1));
    },
    reject: (cause: unknown) => onFailure(cause),
    endEvent: () => platform.emitSync({ ...platform.sync.getSnapshot(), control: { ...control, status: "ended", participants: [] } }),
  };
}
