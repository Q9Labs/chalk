import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CloudflareSFUError } from "../media";
import { ChalkAPIError } from "../server/errors";
import type { ConnectionDependencies, ConnectionMediaFactoryInput } from "./dependencies";
import { control, joinWithTerminalControl, terminalTestClient, terminalTestPlatform } from "../space-client/terminal.test.helpers";

beforeEach(() => vi.stubGlobal("fetch", async () => new Response(null, { status: 204 })));
afterEach(() => vi.unstubAllGlobals());

describe("Episode end wins media rejection", () => {
  // Sanitized production ordering: guest publications GET 403 at 22:23:26.369,
  // media.end_episode completes at 22:23:32.540; provider close_tracks returns 410.
  // The Sync replica is still active at the rejection, not already ended.
  it.each([401, 403, 410])("ends cleanly before Sync's end event after HTTP %s during provider teardown", async (status) => {
    const test = fixture();
    test.status.mockResolvedValue("ending");
    try {
      await joinWithTerminalControl(test.client, test.platform);
      test.reject(new CloudflareSFUError("SFU request rejected during teardown", "signaling_failed", { status }));
      await vi.waitFor(() => expect(test.client.getSnapshot().connection.status).toBe("left"));
      expect(test.platform.sync.getSnapshot().control?.status).toBe("active");
      expect(test.ended).toHaveBeenCalledOnce();
      expect(test.error).not.toHaveBeenCalled();
      expect(test.client.getSnapshot().connection.lastError).toBeNull();
      test.endEvent();
      expect(test.ended).toHaveBeenCalledOnce();
    } finally {
      test.client.dispose();
    }
  });

  it.each([401, 403, 410])("recognizes an already ended Episode after HTTP %s", async (status) => {
    const test = fixture();
    test.status.mockResolvedValue("ended");
    try {
      await joinWithTerminalControl(test.client, test.platform);
      test.reject(new CloudflareSFUError("SFU rejected", "signaling_failed", { status }));
      await vi.waitFor(() => expect(test.ended).toHaveBeenCalledOnce());
      expect(test.error).not.toHaveBeenCalled();
    } finally {
      test.client.dispose();
    }
  });

  it.each([401, 403])("keeps current-binding HTTP %s terminal when the authoritative Episode is active", async (status) => {
    const test = fixture();
    try {
      await joinWithTerminalControl(test.client, test.platform);
      test.reject(new CloudflareSFUError("Revoked media credential", "signaling_failed", { status }));
      await vi.waitFor(() => expect(test.client.getSnapshot().connection.status).toBe("failed"));
      expect(test.client.getSnapshot().connection.lastError).toMatchObject({ code: "access.invalid", recoverable: false });
      expect(test.platform.syncStopped).toHaveBeenCalledOnce();
      expect(test.ended).not.toHaveBeenCalled();
    } finally {
      test.client.dispose();
    }
  });

  it("does not mistake a 410 for Episode end while the Episode is active", async () => {
    const test = fixture();
    try {
      await joinWithTerminalControl(test.client, test.platform);
      test.reject(new CloudflareSFUError("Provider connection gone", "signaling_failed", { status: 410 }));
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(test.ended).not.toHaveBeenCalled();
      expect(test.platform.syncStopped).not.toHaveBeenCalled();
      expect(test.client.getSnapshot().connection.status).not.toBe("failed");
    } finally {
      test.client.dispose();
    }
  });

  it("leaves Sync running when the status read is unavailable so the end event can win", async () => {
    const test = fixture();
    test.status.mockRejectedValue(new Error("Status temporarily unavailable"));
    try {
      await joinWithTerminalControl(test.client, test.platform);
      test.reject(new CloudflareSFUError("Publications rejected", "signaling_failed", { status: 403 }));
      await vi.waitFor(() => expect(test.status).toHaveBeenCalledOnce());
      expect(test.platform.syncStopped).not.toHaveBeenCalled();
      test.endEvent();
      await vi.waitFor(() => expect(test.ended).toHaveBeenCalledOnce());
      expect(test.error).not.toHaveBeenCalled();
    } finally {
      test.client.dispose();
    }
  });

  it("does not block Sync end behind an in-flight status read", async () => {
    const test = fixture();
    const read = Promise.withResolvers<"active">();
    test.status.mockReturnValue(read.promise);
    try {
      await joinWithTerminalControl(test.client, test.platform);
      test.reject(new CloudflareSFUError("Publications rejected", "signaling_failed", { status: 403 }));
      await vi.waitFor(() => expect(test.status).toHaveBeenCalledOnce());
      test.endEvent();
      await vi.waitFor(() => expect(test.ended).toHaveBeenCalledOnce());
      read.resolve("active");
      expect(test.error).not.toHaveBeenCalled();
    } finally {
      read.resolve("active");
      test.client.dispose();
    }
  });

  it.each(["confirmed", "rejected"] as const)("lets a local End in flight settle before classifying media access (%s)", async (outcome) => {
    const test = fixture();
    const ack = Promise.withResolvers<Awaited<ReturnType<typeof test.platform.endEpisode>>>();
    const result = { type: "ack", command_id: "end", delivery: "original", outcome: "satisfied", revision: 2, state_digest: "digest" } as const;
    test.platform.endEpisode.mockReturnValue(ack.promise);
    try {
      await joinWithTerminalControl(test.client, test.platform);
      const ending = test.client.endEpisode().then(
        () => null,
        (error: unknown) => error,
      );
      await vi.waitFor(() => expect(test.platform.endEpisode).toHaveBeenCalledOnce());
      test.reject(new CloudflareSFUError("Close rejected", "signaling_failed", { status: 403 }));
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(test.platform.syncStopped).not.toHaveBeenCalled();
      if (outcome === "confirmed") {
        ack.resolve(result);
        expect(await ending).toBeNull();
        await vi.waitFor(() => expect(test.ended).toHaveBeenCalledOnce());
        expect(test.error).not.toHaveBeenCalled();
      } else {
        ack.reject(new Error("End was not authorized"));
        expect(await ending).not.toBeNull();
        await vi.waitFor(() => expect(test.client.getSnapshot().connection.status).toBe("failed"));
        expect(test.client.getSnapshot().connection.lastError).toMatchObject({ code: "access.invalid", recoverable: false });
        expect(test.ended).not.toHaveBeenCalled();
      }
    } finally {
      ack.resolve(result);
      test.client.dispose();
    }
  });

  it("checks the same Episode state for a replacement conflict", async () => {
    const test = fixture();
    test.status.mockResolvedValue("ending");
    try {
      await joinWithTerminalControl(test.client, test.platform);
      test.reject(new ChalkAPIError({ code: "participant.connection_superseded", status: 409, retryable: false }));
      await vi.waitFor(() => expect(test.ended).toHaveBeenCalledOnce());
      expect(test.error).not.toHaveBeenCalled();
    } finally {
      test.client.dispose();
    }
  });

  it.each([401, 403, 410])("checks Episode state for media startup HTTP %s", async (status) => {
    const test = fixture({
      start: async () => {
        throw new CloudflareSFUError("Start rejected", "signaling_failed", { status });
      },
    });
    test.status.mockResolvedValue("ending");
    try {
      await test.client.join({ microphone: false, camera: false });
      await vi.waitFor(() => expect(test.client.getSnapshot().connection.status).toBe("left"));
      expect(test.error).not.toHaveBeenCalled();
    } finally {
      test.client.dispose();
    }
  });
});

function fixture(mediaOverrides: { start?: () => Promise<void> } = {}) {
  const base = terminalTestPlatform();
  const status = vi.fn<NonNullable<ConnectionDependencies["getEpisodeStatus"]>>().mockResolvedValue("active");
  let onFailure: ConnectionMediaFactoryInput["onFailure"] = () => {};
  const platform = {
    ...base,
    dependencies: {
      ...base.dependencies,
      getEpisodeStatus: status,
      createMediaClient: (input: ConnectionMediaFactoryInput) => {
        onFailure = input.onFailure;
        return { ...base.dependencies.createMediaClient(input), ...mediaOverrides };
      },
    },
  };
  return { platform, status, ...terminalTestClient(platform), reject: (cause: unknown) => onFailure(cause), endEvent: () => platform.emitSync({ ...platform.sync.getSnapshot(), control: { ...control, status: "ended", participants: [] } }) };
}
