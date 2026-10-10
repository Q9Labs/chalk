import { describe, expect, it, vi } from "vitest";
import { opaqueAccessGrant } from "./core.test.helpers";
import { control, terminalTestPlatform } from "./terminal.test.helpers";
import { createSpaceClientForPlatform } from "./space-client";

describe("SpaceClient terminal callbacks", () => {
  it.each(["server end", "participant end", "leave", "removed", "terminal ended welcome", "terminal inactive welcome"] as const)("%s closes transports without an error", async (ending) => {
    const platform = terminalTestPlatform();
    const client = createSpaceClientForPlatform({ space: "test", getAccess: async () => opaqueAccessGrant(1) }, platform);
    const ended = vi.fn();
    const error = vi.fn();
    client.on("episodeEnded", ended);
    client.on("error", error);
    try {
      await client.join({ microphone: false, camera: false });
      platform.emitSync({ ...platform.sync.getSnapshot(), control });
      await vi.waitFor(() => expect(client.getSnapshot().participants.roster).toHaveLength(1));
      if (ending === "leave") await client.leave();
      else if (ending === "participant end") await client.endEpisode();
      else if (ending === "removed" || ending.startsWith("terminal")) platform.emitSync({ ...platform.sync.getSnapshot(), connection: { phase: "terminal", terminalReason: ending === "terminal ended welcome" ? "episode_ended" : "participant_inactive" }, control: null });
      else platform.emitSync({ ...platform.sync.getSnapshot(), control: { ...control, status: ending === "server end" ? "ended" : "active", participants: [] } });
      if (ending === "server end" || ending === "participant end") {
        await vi.waitFor(() => expect(ended).toHaveBeenCalledOnce());
        expect(error).not.toHaveBeenCalled();
      }
      await vi.waitFor(() => expect(client.getSnapshot().connection.status).toBe("left"));
      expect(ended).toHaveBeenCalledTimes(ending === "server end" || ending === "participant end" || ending === "terminal ended welcome" ? 1 : 0);
      if (ended.mock.calls.length) expect(ended).toHaveBeenCalledWith({ episode: expect.objectContaining({ id: "episode-1" }) });
      expect(error).not.toHaveBeenCalled();
      expect(client.getSnapshot().connection.lastError).toBeNull();
      expect(platform.stopped).toHaveBeenCalledOnce();
      expect(platform.syncStopped).toHaveBeenCalledOnce();
      expect(platform.leave).toHaveBeenCalledTimes(ending === "leave" ? 1 : 0);
      // A late duplicate cannot emit another callback or restart transports.
      platform.emitSync({ ...platform.sync.getSnapshot() });
      await client.leave();
      expect(error).not.toHaveBeenCalled();
      expect(platform.stopped).toHaveBeenCalledOnce();
    } finally {
      await client.leave().catch(() => undefined);
      client.dispose();
    }
  });

  it("closes from an acknowledged end even without a final control event", async () => {
    const platform = terminalTestPlatform();
    platform.endEpisode.mockResolvedValue({ type: "ack", command_id: "end", delivery: "original", outcome: "satisfied", revision: 2, state_digest: "digest" });
    const client = createSpaceClientForPlatform({ space: "test", getAccess: async () => opaqueAccessGrant(1) }, platform);
    const ended = vi.fn();
    const error = vi.fn();
    client.on("episodeEnded", ended);
    client.on("error", error);
    try {
      await client.join({ microphone: false, camera: false });
      await client.endEpisode();
      expect(client.getSnapshot().connection.status).toBe("left");
      expect(ended).toHaveBeenCalledOnce();
      expect(error).not.toHaveBeenCalled();
      expect(platform.stopped).toHaveBeenCalledOnce();
    } finally {
      await client.leave().catch(() => undefined);
      client.dispose();
    }
  });

  it("records the end ACK before a concurrent Leave can send another command", async () => {
    const platform = terminalTestPlatform();
    const ack = Promise.withResolvers<Awaited<ReturnType<typeof platform.sync.leave>>>();
    const result = { type: "ack", command_id: "end", delivery: "original", outcome: "satisfied", revision: 2, state_digest: "digest" } as const;
    platform.endEpisode.mockReturnValue(ack.promise);
    platform.leave.mockRejectedValue(new Error("The Episode has already ended"));
    const client = createSpaceClientForPlatform({ space: "test", getAccess: async () => opaqueAccessGrant(1) }, platform);
    const ended = vi.fn();
    const error = vi.fn();
    client.on("episodeEnded", ended);
    client.on("error", error);
    try {
      await client.join({ microphone: false, camera: false });
      const end = client.endEpisode();
      await vi.waitFor(() => expect(platform.endEpisode).toHaveBeenCalledOnce());
      const leave = client.leave();
      ack.resolve(result);
      await Promise.all([end, leave]);
      expect(client.getSnapshot().connection.status).toBe("left");
      expect(platform.leave).not.toHaveBeenCalled();
      expect(ended).toHaveBeenCalledOnce();
      expect(error).not.toHaveBeenCalled();
      expect(platform.stopped).toHaveBeenCalledOnce();
    } finally {
      ack.resolve(result);
      await client.leave().catch(() => undefined);
      client.dispose();
    }
  });

  it("does not end locally from an unconfirmed optimistic end", async () => {
    const platform = terminalTestPlatform();
    const client = createSpaceClientForPlatform({ space: "test", getAccess: async () => opaqueAccessGrant(1) }, platform);
    const ended = vi.fn();
    const error = vi.fn();
    client.on("episodeEnded", ended);
    client.on("error", error);
    try {
      await client.join({ microphone: false, camera: false });
      platform.emitSync({ ...platform.sync.getSnapshot(), control });
      await vi.waitFor(() => expect(client.getSnapshot().participants.roster).toHaveLength(1));
      platform.emitSync({ ...platform.sync.getSnapshot(), control, optimisticControl: { ...control, status: "ended", participants: [] } });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(client.getSnapshot().connection.status).toBe("live");
      expect(ended).not.toHaveBeenCalled();
      expect(error).not.toHaveBeenCalled();
      expect(platform.stopped).not.toHaveBeenCalled();
    } finally {
      await client.leave().catch(() => undefined);
      client.dispose();
    }
  });

  it("rejects an initial terminal welcome with episode.ended without joining or ending a live Episode", async () => {
    const platform = terminalTestPlatform();
    const client = createSpaceClientForPlatform(
      { space: "test", getAccess: async () => opaqueAccessGrant(1) },
      {
        ...platform,
        dependencies: {
          ...platform.dependencies,
          createSyncClient: () => ({
            ...platform.sync,
            stop: platform.syncStopped,
            start: async () => {
              platform.emitSync({ ...platform.sync.getSnapshot(), participantId: "participant-1", participantGeneration: 1, connection: { phase: "terminal", terminalReason: "episode_ended" } });
            },
          }),
        },
      },
    );
    const error = vi.fn();
    const ended = vi.fn();
    const states: string[] = [];
    client.on("error", error);
    client.on("episodeEnded", ended);
    const unsubscribe = client.subscribe(() => states.push(client.getSnapshot().connection.status));
    try {
      await expect(client.join({ microphone: false, camera: false })).rejects.toMatchObject({ code: "episode.ended", recoverable: false });
      expect(client.getSnapshot().connection.status).toBe("failed");
      expect(client.getSnapshot().connection.lastError?.code).toBe("episode.ended");
      expect(states).not.toContain("live");
      expect(error).toHaveBeenCalledOnce();
      expect(error).toHaveBeenCalledWith({ error: expect.objectContaining({ code: "episode.ended" }) });
      expect(ended).not.toHaveBeenCalled();
      expect(platform.syncStopped).toHaveBeenCalledOnce();
      expect(platform.stopped).toHaveBeenCalledOnce();
    } finally {
      unsubscribe();
      client.dispose();
    }
  }, 15_000);

  it.each(["knock admission", "initial control snapshot", "Sync recovery", "new generation rejoin"] as const)("does not infer removal from an empty roster during %s", async (scenario) => {
    const platform = terminalTestPlatform();
    const grant = opaqueAccessGrant(1);
    const generation = scenario === "new generation rejoin" ? 2 : 1;
    const client = createSpaceClientForPlatform(
      { space: "test", getAccess: async () => ({ ...grant, subject: { ...grant.subject, participant_generation: generation } }) },
      {
        ...platform,
        dependencies: {
          ...platform.dependencies,
          createSyncClient: () => ({
            ...platform.sync,
            stop: platform.syncStopped,
            start: async () => {
              platform.emitSync({ ...platform.sync.getSnapshot(), participantId: "participant-1", participantGeneration: generation, connection: { phase: "live" }, control: { ...control, admissionPolicy: scenario === "knock admission" ? "knock" : "open", participants: [] } });
            },
          }),
        },
      },
    );
    const error = vi.fn();
    client.on("error", error);
    try {
      await client.join({ microphone: false, camera: false });
      if (scenario === "Sync recovery") {
        platform.emitSync({ ...platform.sync.getSnapshot(), connection: { phase: "connecting" } });
        await vi.waitFor(() => expect(client.getSnapshot().connection.status).toBe("reconnecting"));
      }
      platform.emitSync({ ...platform.sync.getSnapshot(), connection: { phase: "live" }, control: { ...control, participants: [] } });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(client.getSnapshot().connection.status).toBe("live");
      expect(platform.stopped).not.toHaveBeenCalled();
      expect(platform.syncStopped).not.toHaveBeenCalled();
      expect(error).not.toHaveBeenCalled();
    } finally {
      client.dispose();
    }
  });

  it("keeps retrying an expired Access grant through an outage and recovers without errors", async () => {
    const platform = terminalTestPlatform();
    let now = Date.now();
    const timers = new Map<() => void, number>();
    platform.dependencies.clock.now = () => now;
    platform.dependencies.clock.setTimeout = (callback, delay) => {
      timers.set(callback, delay);
      return callback;
    };
    platform.dependencies.clock.clearTimeout = (callback) => {
      timers.delete(callback as () => void);
    };
    let foreground = () => undefined;
    const access = vi.fn(async () => {
      if (access.mock.calls.length === 2 || access.mock.calls.length === 3) throw new Error("Access unavailable");
      const grant = opaqueAccessGrant(1);
      const expiresAt = new Date(now + 300_000).toISOString();
      return { ...grant, sync: { ...grant.sync, expires_at: expiresAt }, media: { ...grant.media, expires_at: expiresAt, client_payload: { connectionId: access.mock.calls.length > 1 ? "connection-2" : "connection-1", stunServer: "stun:stun.cloudflare.com:3478" } } };
    });
    const client = createSpaceClientForPlatform(
      { space: "test", getAccess: access },
      {
        ...platform,
        dependencies: {
          ...platform.dependencies,
          subscribeForeground: (listener) => {
            foreground = listener;
            return () => undefined;
          },
        },
      },
    );
    const error = vi.fn();
    const ended = vi.fn();
    client.on("error", error);
    client.on("episodeEnded", ended);
    const retry = async (calls: number) => {
      await vi.waitFor(() => expect([...timers.values()]).toContain(5_000));
      expect(client.getSnapshot().connection.status).toBe("live");
      expect(error).not.toHaveBeenCalled();
      const timer = [...timers].find(([, delay]) => delay === 5_000)?.[0];
      if (!timer) throw new Error("Expected the refresh retry timer");
      timers.delete(timer);
      now += 5_000;
      timer();
      await vi.waitFor(() => expect(access).toHaveBeenCalledTimes(calls));
    };
    try {
      await client.join({ microphone: false, camera: false });
      now += 301_000;
      foreground();
      await retry(3);
      await retry(4);
      await vi.waitFor(() => expect([...timers.values()]).toContain(240_000));
      expect(client.getSnapshot().connection.status).toBe("live");
      expect(client.getSnapshot().connection.lastError).toBeNull();
      expect(error).not.toHaveBeenCalled();
      expect(ended).not.toHaveBeenCalled();
      expect(platform.stopped).not.toHaveBeenCalled();
      expect(platform.syncStopped).not.toHaveBeenCalled();
    } finally {
      client.dispose();
    }
  });
});
