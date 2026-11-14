import { Effect, Fiber } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ManualClock } from "../../tests/helpers/manual-clock";
import { parseParsedAccessGrant } from "../access/grant";
import { createCoreTestPlatform, opaqueAccessGrant } from "../space-client/core.test.helpers";
import type { ConnectionAccessRequest } from "./dependencies";
import { ConnectionLifecycleService, makeConnectionLifecycleLayer, type ConnectionLifecycleCapability } from "./lifecycle";

// Replays of the paths that tools/formal/client-recovery/ClientRecovery.tla finds or rules out, against the real
// lifecycle. Each test names its rule from that model. The tests marked "finding" replay a bug the model found;
// they fail on the code from before the fix.

vi.setConfig({ testTimeout: 30000 });
beforeEach(() => vi.stubGlobal("fetch", async () => new Response(null, { status: 204 })));
afterEach(() => vi.unstubAllGlobals());

type Phase = "idle" | "connecting" | "recovering" | "live" | "terminal" | "stopped";

function fixture(options: { readonly grantLifetimeMs?: number; readonly refresh?: "ok" | "unavailable" | "invalid" } = {}) {
  const platform = createCoreTestPlatform();
  const manual = new ManualClock();
  const startedAt = Date.now();
  const clock = { now: () => startedAt + manual.now(), setTimeout: (callback: () => void, delay: number) => manual.setTimeout(callback, delay), clearTimeout: (handle: unknown) => manual.clearTimeout(handle) };
  const refresh = options.refresh ?? "ok";
  const calls = { restart: 0, createSync: 0, access: 0 };
  let whenRestarted = () => {};
  const restart = async () => {
    calls.restart += 1;
    whenRestarted();
  };
  let syncGone = false;
  const createSync = (...input: Parameters<typeof platform.dependencies.createSyncClient>) => {
    calls.createSync += 1;
    return syncGone ? { ...platform.sync, start: async () => Promise.reject(new Error("Sync is unreachable")) } : platform.dependencies.createSyncClient(...input);
  };
  const media = platform.dependencies.createMediaClient({ access: parseParsedAccessGrant(opaqueAccessGrant(1)), credential: async () => "unused", onFailure: () => {}, onScreenEnded: () => {} });
  let generation = 1;
  const access = async (request: ConnectionAccessRequest) => {
    calls.access += 1;
    if (request.reason !== "join" && refresh === "invalid") throw Object.assign(new Error("Participant access was revoked"), { code: "access.invalid" });
    if (request.reason !== "join" && refresh === "unavailable") throw new Error("The access service is unreachable");
    if (request.replaceMediaConnection) generation += 1;
    const grant = opaqueAccessGrant(1, String(generation), `connection-${generation}`);
    const expires_at = new Date(startedAt + (options.grantLifetimeMs ?? 3600000)).toISOString();
    return parseParsedAccessGrant({ ...grant, sync: { ...grant.sync, expires_at }, media: { ...grant.media, expires_at } });
  };
  const mediaPhase = (phase: "live" | "recovering" | "failed") => {
    const snapshot = platform.media.getSnapshot();
    platform.media.emit({ ...snapshot, failure: phase === "failed" ? { code: "peer_connection_failed", recoverable: true } : null, connection: { ...snapshot.connection, phase } });
  };
  const syncPhase = (phase: Phase, terminalReason?: string) => {
    const snapshot = platform.sync.getSnapshot();
    platform.emitSync({ ...snapshot, connection: { ...snapshot.connection, phase, ...(terminalReason ? { terminalReason } : {}) } as typeof snapshot.connection });
  };
  const advance = async (milliseconds: number) => {
    const target = manual.now() + milliseconds;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    while (manual.now() < target) {
      manual.advance(Math.min(100, target - manual.now()));
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  };
  const leaveAck = Promise.withResolvers<Awaited<ReturnType<typeof platform.sync.leave>>>();
  const ackLeave = () => leaveAck.resolve({ type: "ack", command_id: "leave", delivery: "original", outcome: "satisfied", revision: 2, state_digest: "digest" });
  const run = (exercise: (lifecycle: ConnectionLifecycleCapability) => Effect.Effect<void>) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const lifecycle = yield* Effect.service(ConnectionLifecycleService);
        yield* lifecycle.join();
        yield* exercise(lifecycle).pipe(Effect.ensuring(Effect.sync(ackLeave)));
      }).pipe(
        Effect.scoped,
        Effect.provide(
          makeConnectionLifecycleLayer({
            access,
            apiBaseURL: "https://api.chalk.test",
            syncURL: "wss://sync.chalk.test/v1/sync",
            dependencies: { ...platform.dependencies, clock, createSyncClient: createSync, createMediaClient: () => ({ ...media, restart }) },
          }),
        ),
      ),
    );
  return {
    platform,
    calls,
    /** Makes the next restarts bring the media back to live, as a working media client does. */
    restartRecoversMedia: () => {
      whenRestarted = () => mediaPhase("live");
    },
    mediaPhase,
    syncPhase,
    advance,
    run,
    ackLeave,
    holdLeave: () => vi.spyOn(platform.sync, "leave").mockReturnValue(leaveAck.promise),
    /** Every Sync client made from now on fails to start, so a Sync that goes down never comes back. */
    loseSyncForGood: () => {
      syncGone = true;
    },
  };
}

const wait = (promise: Promise<void>) => Effect.promise(() => promise);

describe("Leave is never undone by a late recovery (LeaveNotUndone)", () => {
  it("stays leaving when the quiet period of a recovery ends during Leave", async () => {
    const test = fixture();
    test.holdLeave();
    await test.run((lifecycle) =>
      Effect.gen(function* () {
        yield* wait(test.advance(1000));
        test.mediaPhase("failed");
        yield* wait(test.advance(100));
        const leaving = yield* Effect.forkChild(lifecycle.leave());
        yield* wait(test.advance(500));
        expect(lifecycle.getSnapshot().state).toBe("leaving");
        test.ackLeave();
        yield* Fiber.join(leaving);
        yield* wait(test.advance(90000));
        expect(lifecycle.getSnapshot().state).toBe("left");
        expect(test.calls.restart).toBe(0);
      }),
    );
  });
});

describe("A recovery cycle never abandons a pending recovery (NoAbandonedRecovery)", () => {
  it("restarts media that failed while the call was live", async () => {
    const test = fixture();
    test.restartRecoversMedia();
    await test.run((lifecycle) =>
      Effect.gen(function* () {
        yield* wait(test.advance(1000));
        test.mediaPhase("failed");
        yield* wait(test.advance(3000));
        expect(test.calls.restart).toBeGreaterThan(0);
        expect(lifecycle.getSnapshot().state).toBe("live");
      }),
    );
  });

  // Finding F1. The model finds it as RecoveryEnds failing when Sync dies for good (SyncMayDie).
  // Steps: Sync goes down and never returns; a media blip is reported after it. `recover` used to overwrite
  // `recoveryQueued` with "media", so the cycle used a media plan, which never fails the Connection.
  // A queued sync recovery now stays sync, so both orders fail with sync_recovery_exhausted.
  it("fails the Connection when Sync is gone for good and media blips after it, as it does in the other order", async () => {
    const test = fixture();
    await test.run((lifecycle) =>
      Effect.gen(function* () {
        yield* wait(test.advance(1000));
        test.loseSyncForGood();
        test.mediaPhase("recovering");
        yield* wait(test.advance(20));
        test.syncPhase("connecting");
        yield* wait(test.advance(20));
        test.mediaPhase("live");
        yield* wait(test.advance(120000));
        expect(lifecycle.getSnapshot()).toMatchObject({ state: "failed", failure: { code: "sync_recovery_exhausted" } });
      }),
    );
  });

  it("fails the Connection when media blips after Sync is gone for good (finding F1)", async () => {
    const test = fixture();
    await test.run((lifecycle) =>
      Effect.gen(function* () {
        yield* wait(test.advance(1000));
        test.loseSyncForGood();
        test.syncPhase("connecting");
        yield* wait(test.advance(20));
        test.mediaPhase("recovering");
        yield* wait(test.advance(20));
        test.mediaPhase("live");
        yield* wait(test.advance(120000));
        expect(lifecycle.getSnapshot()).toMatchObject({ state: "failed", failure: { code: "sync_recovery_exhausted" } });
      }),
    );
  });
});

describe("Leave stops recovery before it reaches for new connections (NoRestartWhileLeaving)", () => {
  // Finding F2. Steps: media is recovering, so a recovery attempt is waiting. You press Leave
  // and the Leave acknowledgement is slow. Media fails. The waiting attempt used to go on, so its next round
  // refreshed access and restarted media while the Connection was leaving. Leave now ends the recovery.
  it("does not restart media while Leave waits for its acknowledgement (finding F2)", async () => {
    const test = fixture();
    test.holdLeave();
    await test.run((lifecycle) =>
      Effect.gen(function* () {
        yield* wait(test.advance(1000));
        test.mediaPhase("recovering");
        yield* wait(test.advance(1000));
        expect(lifecycle.getSnapshot().state).toBe("reconnecting");
        const leaving = yield* Effect.forkChild(lifecycle.leave());
        yield* wait(test.advance(100));
        expect(lifecycle.getSnapshot().state).toBe("leaving");
        const requestsBefore = test.calls.access;
        test.mediaPhase("failed");
        yield* wait(test.advance(10000));
        expect(lifecycle.getSnapshot().state).toBe("leaving");
        expect(test.calls.restart).toBe(0);
        expect(test.calls.access).toBe(requestsBefore);
        test.ackLeave();
        yield* Fiber.join(leaving);
      }),
    );
  });
});

describe("A final Sync frame ends the call at once (EndingIsFinal, RemovalReported)", () => {
  it.each(["participant_removed", "episode_ended"] as const)("leaves, reports the reason and never reconnects after %s", async (reason) => {
    const test = fixture();
    await test.run((lifecycle) =>
      Effect.gen(function* () {
        yield* wait(test.advance(1000));
        test.mediaPhase("failed");
        yield* wait(test.advance(300));
        test.syncPhase("terminal", reason);
        yield* wait(test.advance(100));
        expect(lifecycle.getSnapshot()).toMatchObject({ state: "left", removedByHost: reason === "participant_removed" });
        const created = test.calls.createSync;
        const restarted = test.calls.restart;
        yield* wait(test.advance(120000));
        expect(lifecycle.getSnapshot().state).toBe("left");
        expect(test.calls.restart).toBe(restarted);
        expect(test.calls.createSync).toBe(created);
      }),
    );
  });
});

describe("A refresh failure never leaves the client live on a dead grant (RevokedGrantNotLive, ExpiredGrantNotLive)", () => {
  it("fails the Connection when the refresh finds the access revoked", async () => {
    const test = fixture({ grantLifetimeMs: 120000, refresh: "invalid" });
    await test.run((lifecycle) =>
      Effect.gen(function* () {
        yield* wait(test.advance(130000));
        expect(lifecycle.getSnapshot().state).toBe("failed");
      }),
    );
  });

  // Finding F3. Steps: the refresh keeps failing with "unavailable" until the grant has run out. The refresh
  // used to retry with a back-off for ever while the Connection stayed live and showed no failure.
  it("fails the Connection with a reason once the grant has run out and the refresh keeps failing (finding F3)", async () => {
    const test = fixture({ grantLifetimeMs: 120000, refresh: "unavailable" });
    await test.run((lifecycle) =>
      Effect.gen(function* () {
        yield* wait(test.advance(300000));
        expect(lifecycle.getSnapshot()).toMatchObject({ state: "failed", failure: { code: "access_unavailable", recoverable: true } });
      }),
    );
  });
});
