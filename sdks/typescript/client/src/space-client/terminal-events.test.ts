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
      else if (ending.startsWith("terminal")) platform.emitSync({ ...platform.sync.getSnapshot(), connection: { phase: "terminal", terminalReason: ending === "terminal ended welcome" ? "episode_ended" : "participant_inactive" }, control: null });
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

  it("reports expired Access once when refresh is unavailable", async () => {
    const platform = terminalTestPlatform();
    let now = Date.now();
    platform.dependencies.clock.now = () => now;
    let foreground = () => undefined;
    const access = vi.fn(async () => {
      if (access.mock.calls.length > 1) throw new Error("Access unavailable");
      return opaqueAccessGrant(1);
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
    try {
      await client.join({ microphone: false, camera: false });
      now += 301_000;
      foreground();
      await vi.waitFor(() => expect(client.getSnapshot().connection.status).toBe("failed"));
      expect(error).toHaveBeenCalledOnce();
      expect(error).toHaveBeenCalledWith({ error: expect.objectContaining({ code: "access.unavailable", recoverable: false }) });
      expect(ended).not.toHaveBeenCalled();
      expect(platform.stopped).toHaveBeenCalledOnce();
      expect(platform.syncStopped).toHaveBeenCalledOnce();
    } finally {
      await client.leave().catch(() => undefined);
      client.dispose();
    }
  });
});
