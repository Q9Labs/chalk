import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ManualClock } from "../../tests/helpers/manual-clock";
import { parseParsedAccessGrant, requireParsedAccessGrant } from "../access/grant";
import { ChalkAPIError } from "../server/errors";
import { CloudflareSFUError } from "../media";
import { createCoreTestPlatform, opaqueAccessGrant } from "../space-client/core.test.helpers";
import type { ConnectionAccessRequest } from "./dependencies";
import { ConnectionLifecycleService, makeConnectionLifecycleLayer, type ConnectionLifecycleCapability } from "./lifecycle";

// Sanitized SDK 5.2.4 report timings. Sync stayed live (heartbeat gap: 311 ms).
const observed = { live: 1854, accessRefreshed: 10834, disconnected: 47243, reconnecting: 47494, failed: 57234, exhausted: 57502 };

beforeEach(() => vi.stubGlobal("fetch", async () => new Response(null, { status: 204 })));
afterEach(() => vi.unstubAllGlobals());

describe("media recovery deadline", () => {
  it.each(["recovers", "keeps failing"] as const)("retries the reported media loss for the full Sync budget when media %s", async (outcome) => {
    const test = mediaRecoveryFixture();
    test.restart.mockRejectedValue(new Error("Temporary media failure"));
    await test.run(async (lifecycle) => {
      await test.advanceTo(observed.live);
      expect(lifecycle.getSnapshot().state).toBe("live");
      await test.advanceTo(observed.accessRefreshed);
      expect(lifecycle.getDiagnostics()).toContainEqual(expect.objectContaining({ event: "access_refreshed", state: "live" }));
      expect(test.access.mock.calls[1]?.[0]).toMatchObject({ reason: "scheduled_refresh", replaceMediaConnection: false });

      await test.advanceTo(observed.disconnected);
      test.mediaPhase("recovering");
      await test.advanceTo(observed.reconnecting);
      expect(lifecycle.getSnapshot()).toMatchObject({ state: "reconnecting", failure: null, connection: { sync: "healthy" } });
      expect(test.restart).not.toHaveBeenCalled();

      await test.advanceTo(observed.failed);
      test.mediaPhase("failed");
      await test.advanceTo(observed.exhausted);
      expect(lifecycle.getDiagnostics().filter((event) => event.event === "recovery_exhausted")).toEqual([]);
      await test.advanceTo(85000);
      expect(test.restart.mock.calls.length).toBeGreaterThan(3);
      expect(lifecycle.getSnapshot()).toMatchObject({ state: "reconnecting", failure: null, connection: { sync: "healthy" } });
      expect(test.stopSync).not.toHaveBeenCalled();
      expect(test.stopMedia).not.toHaveBeenCalled();
      expect(test.createSync).toHaveBeenCalledTimes(1);
      expect(test.access.mock.calls.slice(2).every(([request]) => request.reason === "media_recovery" && request.replaceMediaConnection && request.expectedParticipantGeneration === 1 && request.currentMediaToken !== undefined)).toBe(true);

      if (outcome === "recovers") {
        test.restart.mockImplementation(async () => test.mediaPhase("live"));
        await test.advanceTo(95000);
        expect(lifecycle.getSnapshot()).toMatchObject({ state: "live", failure: null, connection: { sync: "healthy", media: "healthy" } });
        expect(lifecycle.getDiagnostics().filter((event) => event.event === "recovery_exhausted")).toEqual([]);
      } else {
        const firstAttempt = lifecycle.getDiagnostics().find((event) => event.event === "recovery_attempt");
        expect(firstAttempt).toBeDefined();
        await test.advanceTo((firstAttempt?.timestamp ?? 0) - test.startedAt + 59999);
        expect(lifecycle.getDiagnostics().filter((event) => event.event === "recovery_exhausted")).toEqual([]);
        await test.advanceTo((firstAttempt?.timestamp ?? 0) - test.startedAt + 60001);
        const exhausted = lifecycle.getDiagnostics().find((event) => event.event === "recovery_exhausted");
        expect(exhausted).toMatchObject({ code: "media_recovery_exhausted" });
        expect((exhausted?.timestamp ?? 0) - (firstAttempt?.timestamp ?? 0)).toBeGreaterThanOrEqual(60000);
        expect(lifecycle.getSnapshot()).toMatchObject({ state: "reconnecting", failure: { code: "media_recovery_exhausted", recoverable: true } });
        expect(test.stopSync).not.toHaveBeenCalled();
      }
      const retries = lifecycle.getDiagnostics().filter((event) => event.event === "recovery_attempt");
      for (let index = 1; index < retries.length; index++) {
        const gap = (retries[index]?.timestamp ?? 0) - (retries[index - 1]?.timestamp ?? 0);
        expect(gap).toBeGreaterThanOrEqual(250);
        // The first attempt includes the observed 9.74-second peer wait.
        expect(gap).toBeLessThanOrEqual(index === 1 ? 16000 : 6500);
      }
    });
  });

  it.each([401, 403])("does not reclaim another tab's same-generation seat after live media is rejected (%s)", async (status) => {
    const test = mediaRecoveryFixture();
    await test.run(async (lifecycle) => {
      test.setBinding("another-tabs-connection");
      test.mediaPhase("failed");
      test.failMedia(new CloudflareSFUError("Obsolete media binding", "signaling_failed", { status }));
      await test.advanceTo(60000);
      expect(lifecycle.getSnapshot()).toMatchObject({ state: "failed", failure: { code: "invalid_access", recoverable: false } });
      expect(test.access).toHaveBeenCalledTimes(1);
      expect(test.restart).not.toHaveBeenCalled();
      expect(test.getBinding()).toBe("another-tabs-connection");
      expect(test.createSync).toHaveBeenCalledTimes(1);
    });
  });

  it.each([401, 403])("does not retry a rejected media restart (%s)", async (status) => {
    const test = mediaRecoveryFixture();
    test.restart.mockRejectedValue(new CloudflareSFUError("Rejected media restart", "signaling_failed", { status }));
    await test.run(async (lifecycle) => {
      test.mediaPhase("failed");
      await test.advanceTo(60000);
      expect(lifecycle.getSnapshot()).toMatchObject({ state: "failed", failure: { code: "invalid_access", recoverable: false } });
      expect(test.restart).toHaveBeenCalledTimes(1);
      expect(test.access.mock.calls.map(([request]) => request.reason)).toEqual(["join", "media_recovery"]);
    });
  });

  it("ignores a queued rejection for a binding replaced by a newer recovery grant", async () => {
    const test = mediaRecoveryFixture();
    test.restart.mockRejectedValue(new Error("Temporary media failure"));
    await test.run(async (lifecycle) => {
      test.mediaPhase("failed");
      await test.advanceTo(1000);
      expect(test.getBinding()).not.toBe("connection-1");
      test.failMedia(new CloudflareSFUError("Old binding rejected", "signaling_failed", { status: 403 }), "connection-1");
      await test.advanceTo(1500);
      expect(lifecycle.getSnapshot()).toMatchObject({ state: "reconnecting", failure: null });
    });
  });

  it.each(["server", "response"] as const)("preserves a takeover at recovery second 20 with a %s conflict at second 25", async (conflictSource) => {
    const test = mediaRecoveryFixture(undefined, conflictSource);
    test.restart.mockRejectedValue(new Error("Temporary media failure"));
    await test.run(async (lifecycle) => {
      test.mediaPhase("failed");
      await test.advanceTo(20000);
      expect(lifecycle.getSnapshot().state).toBe("reconnecting");
      test.setBinding("legitimate-new-tab");
      await test.advanceTo(25500);
      expect(test.getBinding()).toBe("legitimate-new-tab");
      expect(lifecycle.getSnapshot()).toMatchObject({ state: "failed", failure: { code: "invalid_access", recoverable: false, message: expect.stringContaining("Another tab or device may be using it") } });
      const count = test.access.mock.calls.length;
      await test.advanceTo(60000);
      expect(test.access).toHaveBeenCalledTimes(count);
    });
  });

  it.each([undefined, [0]])("uses at most twelve replacement grants per minute even with backoff %s", async (backoffMs) => {
    const test = mediaRecoveryFixture(backoffMs);
    test.restart.mockRejectedValue(new Error("Temporary media failure"));
    await test.run(async () => {
      test.mediaPhase("failed");
      await test.advanceTo(60000);
      const grants = test.access.mock.calls.filter(([request]) => request.replaceMediaConnection);
      expect(grants.length).toBeGreaterThan(3);
      expect(grants.length).toBeLessThanOrEqual(12);
      expect(test.restart).toHaveBeenCalledTimes(grants.length);
    });
  });
});

function mediaRecoveryFixture(backoffMs?: readonly number[], conflictSource: "server" | "response" = "server") {
  const platform = createCoreTestPlatform();
  const manual = new ManualClock();
  const startedAt = Date.now();
  let binding = "connection-1";
  let generation = 1;
  const clock = { now: () => startedAt + manual.now(), setTimeout: (callback: () => void, delay: number) => manual.setTimeout(callback, delay), clearTimeout: (handle: unknown) => manual.clearTimeout(handle) };
  const mediaPhase = (phase: "live" | "recovering" | "failed") => {
    const snapshot = platform.media.getSnapshot();
    platform.media.emit({ ...snapshot, failure: phase === "failed" ? { code: "peer_connection_failed", recoverable: true } : null, connection: { ...snapshot.connection, phase } });
  };
  const restart = vi.fn(async () => {});
  const media = platform.dependencies.createMediaClient({ access: parseParsedAccessGrant(opaqueAccessGrant(1)), credential: async () => "unused", onFailure: () => {}, onScreenEnded: () => {} });
  const stopMedia = vi.spyOn(media, "stop");
  const stopSync = vi.spyOn(platform.sync, "stop");
  const createSync = vi.fn(platform.dependencies.createSyncClient);
  let failMedia: (cause: unknown, binding?: string) => void = () => {};
  const access = vi.fn(async (request: ConnectionAccessRequest) => {
    if (request.replaceMediaConnection && request.expectedMediaConnectionId !== undefined && request.expectedMediaConnectionId !== binding) {
      if (conflictSource === "response") return requireParsedAccessGrant(Response.json({ error: { code: "participant.connection_superseded" } }, { status: 409 }));
      throw new ChalkAPIError({ code: "participant.connection_superseded", status: 409, retryable: false });
    }
    if (request.replaceMediaConnection) binding = `connection-${++generation}`;
    const grant = opaqueAccessGrant(generation, String(generation), binding);
    const expires_at = new Date(startedAt + (request.reason === "join" ? observed.accessRefreshed + 60000 : 3600000)).toISOString();
    return parseParsedAccessGrant({ ...grant, sync: { ...grant.sync, expires_at }, media: { ...grant.media, expires_at } });
  });
  return {
    startedAt,
    access,
    restart,
    stopMedia,
    stopSync,
    createSync,
    mediaPhase,
    failMedia: (cause: unknown, binding?: string) => failMedia(cause, binding),
    setBinding: (value: string) => {
      binding = value;
    },
    getBinding: () => binding,
    advanceTo: async (target: number) => {
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
      while (manual.now() < target) {
        manual.advance(Math.min(100, target - manual.now()));
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    },
    run: (exercise: (lifecycle: ConnectionLifecycleCapability) => Promise<void>) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const lifecycle = yield* Effect.service(ConnectionLifecycleService);
          yield* lifecycle.join();
          yield* Effect.promise(() => exercise(lifecycle));
        }).pipe(
          Effect.scoped,
          Effect.provide(
            makeConnectionLifecycleLayer({
              access,
              recovery: { backoffMs },
              apiBaseURL: "https://api.chalk.test",
              syncURL: "wss://sync.chalk.test/v1/sync",
              dependencies: {
                ...platform.dependencies,
                clock,
                createSyncClient: createSync,
                createMediaClient: (input) => {
                  failMedia = input.onFailure;
                  return { ...media, restart };
                },
              },
            }),
          ),
        ),
      ),
  };
}
