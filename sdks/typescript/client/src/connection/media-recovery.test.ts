import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ManualClock } from "../../tests/helpers/manual-clock";
import { parseParsedAccessGrant } from "../access/grant";
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
        expect(gap).toBeLessThanOrEqual(10000);
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
});

function mediaRecoveryFixture() {
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
  let failMedia: (cause: unknown) => void = () => {};
  const access = vi.fn(async (request: ConnectionAccessRequest) => {
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
    failMedia: (cause: unknown) => failMedia(cause),
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
