import { Deferred, Effect, Fiber } from "effect";
import { describe, expect, it, vi } from "vitest";

import { parseParsedAccessGrant } from "../access/grant";
import { ConnectionAccessFailure } from "../access/manager";
import { createCoreTestPlatform, opaqueAccessGrant } from "../space-client/core.test.helpers";
import { ConnectionLifecycleService, makeConnectionLifecycleLayer, type ConnectionLifecycleCapability } from "./lifecycle";
import type { ConnectionOptions } from "./index";

describe("ConnectionLifecycle Episode snapshot", () => {
  it("records invalid scheduled refresh evidence before failing", async () => {
    const platform = createCoreTestPlatform();
    const { clock, advance, waitingFor } = controlledLifecycleClock();
    const access = vi.fn(async () => {
      const grant = parseParsedAccessGrant(opaqueAccessGrant(1));
      const expiresAt = new Date(clock.now() + 1_000).toISOString();
      return { ...grant, sync: { ...grant.sync, expiresAt }, media: { ...grant.media, expiresAt } };
    });
    const layer = testLifecycleLayer({ access, accessRefreshWindowMs: 0, dependencies: { ...platform.dependencies, clock } });
    await Effect.runPromise(
      withJoinedLifecycle((lifecycle) =>
        Effect.promise(async () => {
          await vi.waitFor(() => expect(waitingFor(1_000)).toBe(true));
      access.mockRejectedValue(new ConnectionAccessFailure({ code: "access.invalid", cause: "invalid scheduled refresh" }));
          await advance(1_000);
          await vi.waitFor(() => expect(lifecycle.getSnapshot().state).toBe("failed"));
          expect(lifecycle.getDiagnostics()).toContainEqual(expect.objectContaining({ event: "access_refresh_failed", code: "invalid_access" }));
        }),
      ).pipe(Effect.scoped, Effect.provide(layer)),
    );
  });
  it("leaves Sync recovery and command eligibility unchanged during a brief transport loss", async () => {
    const platform = createCoreTestPlatform();
    const access = parseParsedAccessGrant({
      subject: { tenant_id: "tenant-1", space_id: "space-1", episode_id: "episode-1", participant_id: "participant-1", participant_generation: 1 },
      sync: { token: credential("chalk-sync"), expires_at: "2030-08-25T10:05:00.000Z" },
      media: { token: credential("chalk-media"), expires_at: "2030-08-25T10:05:00.000Z", provider: "cloudflare_sfu", client_payload: { connectionId: "connection-1", stunServer: "stun:test" } },
    });
    let syncCreations = 0;
    let mediaRestarts = 0;
    const layer = makeConnectionLifecycleLayer({
      access: async () => access,
      apiBaseURL: "https://api.chalk.test",
      syncURL: "wss://sync.chalk.test/v1/sync",
      dependencies: {
        ...platform.dependencies,
        createSyncClient: () => {
          syncCreations += 1;
          return platform.sync;
        },
        createMediaClient: (input) => {
          const media = platform.dependencies.createMediaClient(input);
          return {
            ...media,
            restart: async () => {
              mediaRestarts += 1;
            },
          };
        },
      },
    });

    await Effect.runPromise(
      Effect.gen(function* () {
        const lifecycle = yield* Effect.service(ConnectionLifecycleService);
        yield* lifecycle.join();
        const live = platform.sync.getSnapshot();
        let release = () => undefined;
        let entered = () => undefined;
        const enteredQueue = new Promise<void>((resolve) => {
          entered = resolve;
        });
        const pendingAction = yield* Effect.forkChild(
          lifecycle.runCommand(() =>
            Effect.promise(
              () =>
                new Promise<void>((resolve) => {
                  release = resolve;
                  entered();
                }),
            ),
          ),
          { startImmediately: true },
        );
        yield* Effect.promise(() => enteredQueue);
        platform.emitSync({ ...live, connection: { phase: "live", noticeUnresponsive: true } });
        yield* Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, 20)));
        const noticeDuringAction = lifecycle.getSnapshot();
        release();
        yield* Fiber.join(pendingAction);
        expect(noticeDuringAction).toMatchObject({ state: "live", connection: { sync: "unresponsive" } });
        platform.emitSync({ ...live, connection: { phase: "connecting" } });
        yield* Effect.promise(() => vi.waitFor(() => expect(lifecycle.getSnapshot()).toMatchObject({ state: "live", connection: { sync: "connecting" } })));
        platform.emitSync({ ...live, connection: { phase: "recovering" } });
        yield* Effect.promise(() => vi.waitFor(() => expect(lifecycle.getSnapshot().connection.sync).toBe("recovering")));
        expect(syncCreations).toBe(1);
        expect(lifecycle.getSnapshot()).toMatchObject({ state: "live", connection: { sync: "recovering" } });
        platform.emitSync({ ...live, connection: { phase: "live" } });
        yield* Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, 20)));
        expect(lifecycle.getSnapshot().state).toBe("live");
        expect(syncCreations).toBe(1);
        expect(mediaRestarts).toBe(0);
      }).pipe(Effect.provide(layer)),
    );
  });

  it("carries the server Episode start time into the live snapshot", async () => {
    const platform = createCoreTestPlatform();
    const access = parseParsedAccessGrant({
      subject: { tenant_id: "tenant-1", space_id: "space-1", episode_id: "episode-1", participant_id: "participant-1", participant_generation: 1 },
      episode_started_at: "2026-08-25T10:00:00.000Z",
      sync: { token: credential("chalk-sync"), expires_at: "2030-08-25T10:05:00.000Z" },
      media: { token: credential("chalk-media"), expires_at: "2030-08-25T10:05:00.000Z", provider: "cloudflare_sfu", client_payload: { connectionId: "connection-1", stunServer: "stun:test" } },
    });
    const layer = makeConnectionLifecycleLayer({
      access: async () => access,
      apiBaseURL: "https://api.chalk.test",
      syncURL: "wss://sync.chalk.test/v1/sync",
      dependencies: platform.dependencies,
    });
    const snapshot = await Effect.runPromise(
      Effect.gen(function* () {
        const lifecycle = yield* Effect.service(ConnectionLifecycleService);
        yield* lifecycle.join();
        return lifecycle.getSnapshot();
      }).pipe(Effect.provide(layer)),
    );

    expect(snapshot.state).toBe("live");
    expect(snapshot.episode).toMatchObject({ id: "episode-1", startedAt: "2026-08-25T10:00:00.000Z" });
  });
  it("does not block lifecycle loss or other actions behind a long-running upload", async () => {
    const platform = createCoreTestPlatform();
    const layer = testLifecycleLayer({ access: async () => parseParsedAccessGrant(opaqueAccessGrant(1)), dependencies: platform.dependencies, recovery: { budgetMs: 50, maxAttempts: 1 } });
    await Effect.runPromise(
      withJoinedLifecycle((lifecycle) =>
        Effect.gen(function* () {
          const started = yield* Deferred.make<void>();
          const uploaded = yield* Deferred.make<string>();
          const upload = yield* Effect.forkScoped(lifecycle.runPortCommand(() => Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(uploaded)))));
          yield* Deferred.await(started);
          const result = yield* lifecycle.runCommand(() => Effect.succeed("action completed")).pipe(Effect.timeout(100), Effect.result);
          expect(result).toMatchObject({ _tag: "Success", success: "action completed" });
          platform.emitSync({ ...platform.sync.getSnapshot(), connection: { phase: "connecting" } });
          yield* Effect.sleep(400);
          expect(lifecycle.getSnapshot()).toMatchObject({ state: "reconnecting", failure: { recoverable: true } });
          yield* Deferred.succeed(uploaded, "finalized");
          expect(yield* Fiber.join(upload)).toBe("finalized");
        }),
      ).pipe(Effect.scoped, Effect.provide(layer)),
    );
  });

  it("backs off scheduled access refresh failures and resets after success", async () => {
    const platform = createCoreTestPlatform();
    const { clock, advance, waitingFor: waiting } = controlledLifecycleClock();
    const freshGrant = replacementAccess();
    const fetchAccess = async () => {
      const grant = await freshGrant();
      return { ...grant, sync: { ...grant.sync, expiresAt: new Date(clock.now() + 1_000).toISOString() }, media: { ...grant.media, expiresAt: new Date(clock.now() + 1_000).toISOString() } };
    };
    const access = vi.fn(fetchAccess);
    const layer = testLifecycleLayer({ access, accessRefreshWindowMs: 0, dependencies: { ...platform.dependencies, clock } });
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* joinedLifecycle();
        yield* Effect.promise(async () => {
          await vi.waitFor(() => expect(waiting(1_000)).toBe(true));
          access.mockRejectedValue(new Error("Temporary access outage"));
          await advance(1_000);
          await vi.waitFor(() => expect(access).toHaveBeenCalledTimes(2));
          for (const delay of [5_000, 10_000, 20_000, 40_000, 60_000, 60_000]) {
            await vi.waitFor(() => expect(waiting(delay)).toBe(true));
            const before = access.mock.calls.length;
            await advance(delay);
            await vi.waitFor(() => expect(access).toHaveBeenCalledTimes(before + 1));
          }
          access.mockImplementation(fetchAccess);
          await vi.waitFor(() => expect(waiting(60_000)).toBe(true));
          await advance(60_000);
          await vi.waitFor(() => expect(waiting(1_000)).toBe(true));
          access.mockRejectedValue(new Error("Temporary access outage"));
          await advance(1_000);
          await vi.waitFor(() => expect(waiting(5_000)).toBe(true));
        });
      }).pipe(Effect.provide(layer)),
    );
  });

  it.each(["access", "media_snapshot", "sync_snapshot"] as const)("backs off exhausted background cycles and resumes after %s recovery", async (recovery) => {
    vi.spyOn(Math, "random").mockReturnValue(1);
    const platform = createCoreTestPlatform();
    const { clock, advance, waitingFor } = controlledLifecycleClock();
    const grantProvider = replacementAccess();
    const fetchAccess = async () => {
      const grant = await grantProvider();
      const expiresAt = new Date(clock.now() + 3_600_000).toISOString();
      return { ...grant, sync: { ...grant.sync, expiresAt }, media: { ...grant.media, expiresAt } };
    };
    const access = vi.fn(fetchAccess);
    const media = testMediaClient(platform);
    vi.spyOn(media, "restart").mockImplementation(async () => emitMediaPhase(platform, "live"));
    const layer = testLifecycleLayer({ access, dependencies: { ...platform.dependencies, clock }, recovery: { budgetMs: 1_000, maxAttempts: 1 } });
    try {
      await Effect.runPromise(
        joinedLifecycle().pipe(
          Effect.flatMap((lifecycle) =>
            Effect.promise(async () => {
              access.mockRejectedValue(new Error("access temporarily unavailable"));
              emitMediaPhase(platform, "failed");
              await vi.waitFor(() => expect(waitingFor(250)).toBe(true));
              await advance(250);
              await vi.waitFor(() => expect(access).toHaveBeenCalledTimes(2));
              for (const delay of [250, 500, 1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000]) {
                await vi.waitFor(() => expect(waitingFor(delay)).toBe(true));
                const calls = access.mock.calls.length;
                await advance(delay - 1);
                expect(access).toHaveBeenCalledTimes(calls);
                await advance(1);
                await vi.waitFor(() => expect(access).toHaveBeenCalledTimes(calls + 1));
              }
              await vi.waitFor(() => expect(waitingFor(60_000)).toBe(true));
              if (recovery === "access") {
                access.mockImplementation(fetchAccess);
                await advance(60_000);
              } else {
                if (recovery === "sync_snapshot") platform.emitSync({ ...platform.sync.getSnapshot(), connection: { phase: "connecting" } });
                emitMediaPhase(platform, "live");
                if (recovery === "sync_snapshot") platform.emitSync({ ...platform.sync.getSnapshot(), connection: { phase: "live" } });
              }
              await vi.waitFor(() => expect(lifecycle.getSnapshot().state).toBe("live"));
              const calls = access.mock.calls.length;
              await advance(60_000);
              expect(access).toHaveBeenCalledTimes(calls);
            }),
          ),
          Effect.scoped,
          Effect.provide(layer),
        ),
      );
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("restarts media again after a recovering adapter hangs past the budget", async () => {
    const platform = createCoreTestPlatform();
    const media = testMediaClient(platform);
    const advanceClock = freezeLifecycleTime(platform);
    const access = vi.fn(replacementAccess());
    const restart = vi
      .spyOn(media, "restart")
      .mockImplementationOnce(async () => {
        emitMediaPhase(platform, "recovering");
        await new Promise<void>(() => {});
      })
      .mockImplementation(async () => {
        emitMediaPhase(platform, "live");
      });
    const layer = testLifecycleLayer({ access, dependencies: platform.dependencies, recovery: { budgetMs: 30, maxAttempts: 1 } });
    await Effect.runPromise(
      joinedLifecycle().pipe(
        Effect.flatMap((lifecycle) =>
          Effect.gen(function* () {
            emitMediaPhase(platform, "failed");
            yield* Effect.promise(() => vi.waitFor(() => expect(restart).toHaveBeenCalledOnce()));
            advanceClock(60_001);
            yield* Effect.promise(() => vi.waitFor(() => expect(restart).toHaveBeenCalledTimes(2), { timeout: 1_500 }));
            yield* Effect.promise(() => vi.waitFor(() => expect(lifecycle.getSnapshot().state).toBe("live"), { timeout: 1_500 }));
            expect(access).toHaveBeenCalledTimes(3);
          }),
        ),
        Effect.provide(layer),
      ),
    );
  });

  it("reconciles media that failed while Sync Join was still pending", async () => {
    const platform = createCoreTestPlatform();
    const media = testMediaClient(platform);
    const restart = vi.spyOn(media, "restart").mockImplementation(async () => {
      emitMediaPhase(platform, "live");
    });
    const sync = {
      ...platform.sync,
      start: async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        emitMediaPhase(platform, "failed");
        await new Promise((resolve) => setTimeout(resolve, 10));
        await platform.sync.start();
      },
    };
    const layer = testLifecycleLayer({
      access: replacementAccess(),
      dependencies: { ...platform.dependencies, createSyncClient: () => sync },
    });
    await Effect.runPromise(
      withJoinedLifecycle((lifecycle) =>
        Effect.gen(function* () {
          yield* Effect.sleep(350);
          expect(restart).toHaveBeenCalledTimes(1);
          expect(lifecycle.getSnapshot()).toMatchObject({ state: "live", connection: { media: "healthy" } });
        }),
      ).pipe(Effect.provide(layer)),
    );
  });

  it("rebuilds an expired replacement Sync start and ignores its late completion", async () => {
    const platform = createCoreTestPlatform();
    const advanceClock = freezeLifecycleTime(platform);
    let finish = () => {};
    let creations = 0;
    const stop = vi.fn();
    const createSyncClient = vi.fn(() => {
      const replacement = ++creations === 2;
      return {
        ...platform.sync,
        stop: replacement ? stop : platform.sync.stop,
        start: replacement
          ? async () => {
              platform.emitSync({ ...platform.sync.getSnapshot(), connection: { phase: "connecting" } });
              await new Promise<void>((resolve) => {
                finish = resolve;
              });
            }
          : platform.sync.start,
      };
    });
    const layer = testLifecycleLayer({ access: async () => parseParsedAccessGrant(opaqueAccessGrant(1)), dependencies: { ...platform.dependencies, createSyncClient }, recovery: { budgetMs: 30, maxAttempts: 1 } });
    await Effect.runPromise(
      withJoinedLifecycle((lifecycle) =>
        Effect.gen(function* () {
          platform.emitSync({ ...platform.sync.getSnapshot(), connection: { phase: "terminal", terminalReason: "fixture_disconnect" } });
          yield* Effect.promise(() => vi.waitFor(() => expect(createSyncClient).toHaveBeenCalledTimes(2)));
          advanceClock(60_001);
          yield* Effect.promise(() => vi.waitFor(() => expect(createSyncClient).toHaveBeenCalledTimes(3), { timeout: 1_500 }));
          expect(stop).toHaveBeenCalledOnce();
          finish();
          yield* waitForLive(lifecycle);
        }),
      ).pipe(Effect.provide(layer)),
    );
  });
});

function credential(audience: "chalk-sync" | "chalk-media"): string {
  const encode = (value: unknown) => btoa(JSON.stringify(value)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
  return `${encode({ alg: "EdDSA" })}.${encode({ aud: audience })}.signature`;
}

function freezeLifecycleTime(platform: ReturnType<typeof createCoreTestPlatform>) {
  let now = Date.now();
  vi.spyOn(platform.dependencies.clock, "now").mockImplementation(() => now);
  return (milliseconds: number) => {
    now += milliseconds;
  };
}

function controlledLifecycleClock() {
  let now = Date.now();
  let next = 0;
  const timers = new Map<number, { at: number; callback: () => void }>();
  const clock = {
    now: () => now,
    setTimeout: (callback: () => void, delay: number) => {
      const id = next++;
      timers.set(id, { at: now + delay, callback });
      return id;
    },
    clearTimeout: (id: unknown) => {
      if (typeof id === "number") timers.delete(id);
    },
  };
  const advance = async (delay: number) => {
    now += delay;
    for (const [id, timer] of [...timers]) {
      if (timer.at > now) continue;
      timers.delete(id);
      timer.callback();
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
  };
  const waitingFor = (delay: number) => [...timers.values()].some((timer) => timer.at === now + delay);
  return { clock, advance, waitingFor };
}

function withJoinedLifecycle<A, E, R>(exercise: (lifecycle: ConnectionLifecycleCapability) => Effect.Effect<A, E, R>) {
  return joinedLifecycle().pipe(Effect.flatMap(exercise));
}

function waitForLive(lifecycle: ConnectionLifecycleCapability) {
  return Effect.promise(() => vi.waitFor(() => expect(lifecycle.getSnapshot().state).toBe("live")));
}

function expectAccessRevoked(lifecycle: ConnectionLifecycleCapability): void {
  expect(lifecycle.getSnapshot()).toMatchObject({ state: "failed", failure: { code: "invalid_access", recoverable: false } });
}

function joinedLifecycle() {
  return Effect.gen(function* () {
    const lifecycle = yield* Effect.service(ConnectionLifecycleService);
    yield* lifecycle.join();
    return lifecycle;
  });
}

function testLifecycleLayer(options: Omit<ConnectionOptions, "apiBaseURL" | "syncURL">) {
  return makeConnectionLifecycleLayer({ apiBaseURL: "https://api.chalk.test", syncURL: "wss://sync.chalk.test/v1/sync", ...options });
}

function testMediaClient(platform: ReturnType<typeof createCoreTestPlatform>) {
  return platform.dependencies.createMediaClient({ access: parseParsedAccessGrant(opaqueAccessGrant(1)), credential: async () => "unused", onFailure: () => undefined, onScreenEnded: () => undefined });
}

function replacementAccess() {
  let grants = 0;
  return async () => {
    const grant = opaqueAccessGrant(1);
    return parseParsedAccessGrant({ ...grant, media: { ...grant.media, client_payload: { connectionId: `replacement-${++grants}`, stunServer: "stun:test" } } });
  };
}

function emitMediaPhase(platform: ReturnType<typeof createCoreTestPlatform>, phase: "live" | "recovering" | "failed"): void {
  const snapshot = platform.media.getSnapshot();
  platform.media.emit({ ...snapshot, failure: phase === "failed" ? { code: "media_failed", recoverable: true } : null, connection: { ...snapshot.connection, phase } });
}
