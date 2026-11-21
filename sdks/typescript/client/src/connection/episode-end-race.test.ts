import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SFUError } from "../media";
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
      test.reject(new SFUError("SFU request rejected during teardown", "signaling_failed", { status: 403 }));
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

  // Sanitized production ordering: the scheduled access refresh answers 409 episode.not_active once the Episode is over.
  it("ends cleanly when a scheduled access refresh finds the Episode no longer active", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      const base = createCoreTestPlatform();
      let grants = 0;
      const getAccess = async () => {
        if (grants++ === 0) return opaqueAccessGrant(1);
        throw { status: 409, error: { code: "episode.not_active", message: "Episode is not active" } };
      };
      const platform = { ...base, dependencies: { ...base.dependencies, getEpisodeStatus: async () => "ended" as const } };
      const client = createSpaceClientForPlatform({ space: "test", getAccess }, platform);
      const ended: unknown[] = [];
      client.on("episodeEnded", (event) => ended.push(event));
      try {
        await client.join({ microphone: false, camera: false });
        platform.emitSync({ ...platform.sync.getSnapshot(), control });
        await vi.advanceTimersByTimeAsync(300_000);
        await vi.waitFor(() => expect(client.getSnapshot().connection.status).toBe("left"));
        expect(ended).toHaveLength(1);
        expect(client.getSnapshot().connection.lastError).toBeNull();
      } finally {
        client.dispose();
      }
    } finally {
      vi.useRealTimers();
    }
  });

  // The media client answers a 403 by asking for a fresh credential; the refresh finds the Episode over, and the media client's
  // poll reports that refusal as a failure, which must end the call instead of leaving it reconnecting.
  it("ends cleanly when a media credential refresh finds the Episode no longer active", async () => {
    let grants = 0;
    const test = fixture("ended", async () => {
      if (grants++ === 0) return opaqueAccessGrant(1);
      throw { status: 409, error: { code: "episode.not_active", message: "Episode is not active" } };
    });
    try {
      await test.join();
      const refusal = await test.refreshCredential().then(
        () => undefined,
        (cause: unknown) => cause,
      );
      expect(refusal).toBeDefined();
      test.reject(refusal);
      await vi.waitFor(() => expect(test.client.getSnapshot().connection.status).toBe("left"));
      expect(test.events.ended).toHaveLength(1);
      expect(test.client.getSnapshot().connection.lastError).toBeNull();
    } finally {
      test.client.dispose();
    }
  });

  it("rejects a revoked credential while the Episode is still active", async () => {
    const test = fixture();
    try {
      await test.join();
      test.reject(new SFUError("Revoked media credential", "signaling_failed", { status: 403 }));
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

function fixture(episodeStatus: "active" | "ending" | "ended" = "active", getAccess: () => Promise<unknown> = async () => opaqueAccessGrant(1)) {
  const base = createCoreTestPlatform();
  const status: NonNullable<ConnectionDependencies["getEpisodeStatus"]> = async () => episodeStatus;
  let onFailure: ConnectionMediaFactoryInput["onFailure"] = () => {};
  let refreshCredential: ConnectionMediaFactoryInput["refreshCredential"];
  const platform = {
    ...base,
    dependencies: {
      ...base.dependencies,
      getEpisodeStatus: status,
      createMediaClient: (input: ConnectionMediaFactoryInput) => {
        onFailure = input.onFailure;
        refreshCredential = input.refreshCredential;
        return base.dependencies.createMediaClient(input);
      },
    },
  };
  const client = createSpaceClientForPlatform({ space: "test", getAccess }, platform);
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
    refreshCredential: async () => refreshCredential?.(),
    endEvent: () => platform.emitSync({ ...platform.sync.getSnapshot(), control: { ...control, status: "ended", participants: [] } }),
  };
}
