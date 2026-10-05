import { Deferred, Effect, Fiber } from "effect";
import { describe, expect, it, vi } from "vitest";

import { parseParsedAccessGrant } from "../access/grant";
import { ConnectionAccessFailure } from "../access/manager";
import { createCoreTestPlatform, opaqueAccessGrant } from "../space-client/core.test.helpers";
import { ConnectionLifecycleService, makeConnectionLifecycleLayer, type ConnectionLifecycleCapability } from "./lifecycle";
import type { ConnectionOptions } from "./index";

describe("ConnectionLifecycle Episode snapshot", () => {
  it("pauses the action deadline while the tab is hidden", async () => {
    const platform = createCoreTestPlatform();
    const layer = testLifecycleLayer({ access: replacementAccess(), dependencies: platform.dependencies, recovery: { budgetMs: 20 } });
    await Effect.runPromise(
      withJoinedLifecycle((lifecycle) =>
        Effect.gen(function* () {
          const visibility = { visibilityState: "hidden" };
          vi.stubGlobal("document", visibility);
          try {
            const receipt = yield* Deferred.make<string>();
            let settled = false;
            const action = yield* Effect.forkScoped(
              lifecycle
                .runCommand(() => Deferred.await(receipt))
                .pipe(
                  Effect.onExit(() =>
                    Effect.sync(() => {
                      settled = true;
                    }),
                  ),
                ),
            );
            yield* Effect.sleep(50);
            expect(settled).toBe(false);
            visibility.visibilityState = "visible";
            yield* Deferred.succeed(receipt, "confirmed");
            expect(yield* Fiber.join(action)).toBe("confirmed");
          } finally {
            vi.unstubAllGlobals();
          }
        }),
      ).pipe(Effect.scoped, Effect.provide(layer)),
    );
  });

  it.each(["media", "sync"] as const)("gives an in-flight %s rebuild a fresh window when a suspended tab returns", async (kind) => {
    const platform = createCoreTestPlatform();
    const advanceClock = freezeLifecycleTime(platform);
    let foreground = () => {};
    const { promise: pending, resolve: finish } = pendingVoid();
    const media = testMediaClient(platform);
    const restart = vi.spyOn(media, "restart").mockImplementationOnce(async () => {
      emitMediaPhase(platform, "recovering");
      await pending;
      emitMediaPhase(platform, "live");
    });
    let count = 0;
    const createSyncClient = vi.fn(() => {
      const replacement = ++count === 2;
      return {
        ...platform.sync,
        start:
          replacement && kind === "sync"
            ? async () => {
                platform.emitSync({ ...platform.sync.getSnapshot(), connection: { phase: "connecting" } });
                await pending;
                await platform.sync.start();
              }
            : platform.sync.start,
      };
    });
    const layer = testLifecycleLayer({
      access: replacementAccess(),
      dependencies: {
        ...platform.dependencies,
        createSyncClient,
        subscribeForeground: (listener) => {
          foreground = listener;
          return () => {};
        },
      },
      recovery: { budgetMs: 30, maxAttempts: 1 },
    });
    await Effect.runPromise(
      withJoinedLifecycle((lifecycle) =>
        Effect.gen(function* () {
          if (kind === "media") emitMediaPhase(platform, "failed");
          else platform.emitSync({ ...platform.sync.getSnapshot(), connection: { phase: "terminal", terminalReason: "fixture_disconnect" } });
          yield* Effect.promise(() => vi.waitFor(() => expect(kind === "media" ? restart.mock.calls.length : createSyncClient.mock.calls.length).toBe(kind === "media" ? 1 : 2)));
          advanceClock(60_001);
          foreground();
          yield* Effect.sleep(500);
          expect(kind === "media" ? restart.mock.calls.length : createSyncClient.mock.calls.length).toBe(kind === "media" ? 1 : 2);
          finish();
          yield* waitForLive(lifecycle);
        }),
      ).pipe(Effect.provide(layer)),
    );
  });

  it("rebuilds a custom Sync transport that never completes its own reconnect", async () => {
    const platform = createCoreTestPlatform();
    const advanceClock = freezeLifecycleTime(platform);
    const createSyncClient = vi.fn(() => ({ ...platform.sync }));
    const layer = testLifecycleLayer({ access: replacementAccess(), dependencies: { ...platform.dependencies, createSyncClient }, recovery: { budgetMs: 30, maxAttempts: 1 } });
    await Effect.runPromise(
      withJoinedLifecycle((lifecycle) =>
        Effect.gen(function* () {
          platform.emitSync({ ...platform.sync.getSnapshot(), connection: { phase: "connecting" } });
          yield* Effect.promise(() => vi.waitFor(() => expect(lifecycle.getSnapshot().failure?.code).toBe("sync_recovery_exhausted")));
          advanceClock(60_001);
          yield* Effect.promise(() => vi.waitFor(() => expect(createSyncClient).toHaveBeenCalledTimes(2), { timeout: 1_500 }));
          yield* waitForLive(lifecycle);
        }),
      ).pipe(Effect.provide(layer)),
    );
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

  it("stops default initial capture when permission is granted after Leave cancelled Join", async () => {
    const platform = createCoreTestPlatform();
    const stop = vi.fn();
    let grant = (_stream: MediaStream) => {};
    const capture = vi.spyOn(platform.dependencies.mediaDevices, "getUserMedia").mockImplementation(
      () =>
        new Promise<MediaStream>((resolve) => {
          grant = resolve;
        }),
    );
    const layer = testLifecycleLayer({ access: replacementAccess(), dependencies: platform.dependencies });
    await Effect.runPromise(
      Effect.gen(function* () {
        const lifecycle = yield* ConnectionLifecycleService;
        yield* Effect.forkScoped(lifecycle.join());
        yield* Effect.promise(() => vi.waitFor(() => expect(capture).toHaveBeenCalledOnce()));
        yield* lifecycle.leave();
        grant({ getTracks: () => [{ stop }] } as unknown as MediaStream);
        yield* Effect.promise(() => vi.waitFor(() => expect(stop).toHaveBeenCalledOnce()));
      }).pipe(Effect.scoped, Effect.provide(layer)),
    );
  });

  it("keeps lifecycle callbacks live while a scheduled access refresh is waiting", async () => {
    const platform = createCoreTestPlatform();
    const grant = opaqueAccessGrant(1);
    let reads = 0;
    let release: (() => void) | undefined;
    const layer = testLifecycleLayer({
      access: async () => {
        if (reads++ > 0)
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        return parseParsedAccessGrant(reads === 1 ? { ...grant, sync: { ...grant.sync, expires_at: new Date(Date.now() + 100).toISOString() } } : grant);
      },
      accessRefreshWindowMs: 0,
      dependencies: platform.dependencies,
    });
    await Effect.runPromise(
      withJoinedLifecycle((lifecycle) =>
        Effect.gen(function* () {
          yield* Effect.promise(() => vi.waitFor(() => expect(release).toBeDefined()));
          platform.emitSync({ ...platform.sync.getSnapshot(), connection: { phase: "recovering" } });
          yield* Effect.sleep(350);
          const snapshot = lifecycle.getSnapshot();
          release?.();
          expect(snapshot).toMatchObject({ state: "reconnecting", connection: { sync: "recovering" } });
        }),
      ).pipe(Effect.provide(layer)),
    );
  });

  it.each(["media", "sync"] as const)("bounds a hung initial %s start after capture and fails locally", async (kind) => {
    const platform = createCoreTestPlatform();
    const start = vi.fn(async () => {
      await new Promise<void>(() => {});
    });
    const timer = platform.dependencies.clock.setTimeout;
    vi.spyOn(platform.dependencies.clock, "setTimeout").mockImplementation((callback, milliseconds) => timer(callback, milliseconds === 60_000 ? 30 : milliseconds));
    const media = testMediaClient(platform);
    const dependencies = { ...platform.dependencies, createMediaClient: () => ({ ...media, start: kind === "media" ? start : media.start }), createSyncClient: () => ({ ...platform.sync, start: kind === "sync" ? start : platform.sync.start }) };
    const layer = testLifecycleLayer({ access: replacementAccess(), dependencies });
    await Effect.runPromise(
      Effect.gen(function* () {
        const lifecycle = yield* ConnectionLifecycleService;
        const result = yield* lifecycle.join().pipe(Effect.timeout(200), Effect.result);
        expect(result).toMatchObject({ _tag: "Failure", failure: { code: kind === "media" ? "media_start_failed" : "sync_start_failed" } });
        expect(lifecycle.getSnapshot().state).toBe("failed");
      }).pipe(Effect.provide(layer)),
    );
  });

  it("keeps actions available while automatic media access replacement hangs", async () => {
    const platform = createCoreTestPlatform();
    const media = testMediaClient(platform);
    let complete = () => {};
    const restart = vi.spyOn(media, "restart").mockImplementation(async () => {
      emitMediaPhase(platform, "recovering");
      await new Promise<void>((resolve) => {
        complete = resolve;
      });
      emitMediaPhase(platform, "live");
    });
    const grants = replacementAccess();
    let calls = 0;
    const access = async () => {
      const grant = await grants();
      return calls++ === 0 ? { ...grant, media: { ...grant.media, expiresAt: new Date(Date.now() + 50).toISOString() } } : grant;
    };
    const layer = testLifecycleLayer({ access, accessRefreshWindowMs: 0, dependencies: platform.dependencies });
    await Effect.runPromise(
      withJoinedLifecycle((lifecycle) =>
        Effect.gen(function* () {
          yield* Effect.promise(() => vi.waitFor(() => expect(restart).toHaveBeenCalledOnce()));
          const result = yield* lifecycle.runCommand(() => Effect.succeed("confirmed")).pipe(Effect.timeout(100), Effect.result);
          complete();
          expect(result).toMatchObject({ _tag: "Success", success: "confirmed" });
        }),
      ).pipe(Effect.provide(layer)),
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

  it("caps an attempt's configured backoff at the remaining cycle budget", async () => {
    const platform = createCoreTestPlatform();
    const access = vi.fn(replacementAccess());
    const media = testMediaClient(platform);
    vi.spyOn(media, "restart").mockImplementation(async () => emitMediaPhase(platform, "live"));
    const layer = testLifecycleLayer({ access, dependencies: platform.dependencies, recovery: { budgetMs: 30, maxAttempts: 3, backoffMs: [600_000] } });
    await Effect.runPromise(
      withJoinedLifecycle((lifecycle) =>
        Effect.gen(function* () {
          access.mockRejectedValueOnce(new Error("Temporary access outage"));
          emitMediaPhase(platform, "failed");
          yield* Effect.promise(() => vi.waitFor(() => expect(access).toHaveBeenCalledTimes(3), { timeout: 1_500 }));
          yield* waitForLive(lifecycle);
        }),
      ).pipe(Effect.provide(layer)),
    );
  });

  it("keeps actions available while media waits for its own recovery", async () => {
    const platform = createCoreTestPlatform();
    const media = testMediaClient(platform);
    let release: (() => void) | undefined;
    const restart = vi.spyOn(media, "restart").mockImplementation(async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      emitMediaPhase(platform, "live");
    });
    const layer = testLifecycleLayer({
      access: replacementAccess(),
      dependencies: platform.dependencies,
      recovery: { budgetMs: 1_000, maxAttempts: 1 },
    });
    await Effect.runPromise(
      withJoinedLifecycle((lifecycle) =>
        Effect.gen(function* () {
          emitMediaPhase(platform, "failed");
          yield* Effect.promise(() => vi.waitFor(() => expect(restart).toHaveBeenCalledOnce()));
          const result = yield* lifecycle.runCommand(() => Effect.succeed("action completed")).pipe(Effect.timeout(100), Effect.result);
          release?.();
          expect(result).toMatchObject({ _tag: "Success", success: "action completed" });
        }),
      ).pipe(Effect.provide(layer)),
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

  it("lets a progressing media rebuild outlive the lifecycle waiting budget", async () => {
    const platform = createCoreTestPlatform();
    const media = testMediaClient(platform);
    let release = () => {};
    const restart = vi.spyOn(media, "restart").mockImplementation(async () => {
      emitMediaPhase(platform, "recovering");
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      emitMediaPhase(platform, "live");
    });
    const layer = testLifecycleLayer({ access: replacementAccess(), dependencies: platform.dependencies, recovery: { budgetMs: 30, maxAttempts: 1 } });
    await Effect.runPromise(
      joinedLifecycle().pipe(
        Effect.flatMap((lifecycle) =>
          Effect.gen(function* () {
            emitMediaPhase(platform, "failed");
            yield* Effect.promise(() => vi.waitFor(() => expect(restart).toHaveBeenCalledOnce()));
            yield* Effect.sleep(450);
            const calls = restart.mock.calls.length;
            release();
            expect(calls).toBe(1);
            yield* Effect.promise(() => vi.waitFor(() => expect(lifecycle.getSnapshot().state).toBe("live"), { timeout: 2_500 }));
          }),
        ),
        Effect.provide(layer),
      ),
    );
  });

  it("does not apply the receipt recovery deadline to a healthy long-running port operation", async () => {
    const platform = createCoreTestPlatform();
    const layer = testLifecycleLayer({ access: async () => parseParsedAccessGrant(opaqueAccessGrant(1)), dependencies: platform.dependencies, recovery: { budgetMs: 10 } });
    await Effect.runPromise(
      withJoinedLifecycle((lifecycle) =>
        Effect.gen(function* () {
          const result = yield* lifecycle.runPortCommand(() => Effect.sleep(30).pipe(Effect.as("finalized")));
          expect(result).toBe("finalized");
        }),
      ).pipe(Effect.provide(layer)),
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

  it("stops recovery when the access provider explicitly revokes Participant access", async () => {
    const platform = createCoreTestPlatform();
    const initial = opaqueAccessGrant(1);
    const access = parseParsedAccessGrant({ ...initial, sync: { ...initial.sync, expires_at: new Date(Date.now() + 100).toISOString() } });
    let reads = 0;
    const layer = testLifecycleLayer({
      access: async () => {
        if (reads++ > 0) throw new ConnectionAccessFailure({ code: "access.invalid", cause: new Error("Participant access revoked") });
        return access;
      },
      accessRefreshWindowMs: 0,
      dependencies: platform.dependencies,
    });
    await Effect.runPromise(
      withJoinedLifecycle((lifecycle) =>
        Effect.gen(function* () {
          yield* Effect.sleep(200);
          expectAccessRevoked(lifecycle);
        }),
      ).pipe(Effect.provide(layer)),
    );
  });
  it("processes loss while an action is awaiting its receipt and heals after the foreground budget", async () => {
    const platform = createCoreTestPlatform();
    const createSyncClient = vi.fn(() => platform.sync);
    const stopMedia = vi.spyOn(testMediaClient(platform), "stop");
    const layer = testLifecycleLayer({
      access: async () => parseParsedAccessGrant(opaqueAccessGrant(1)),
      recovery: { budgetMs: 50, maxAttempts: 1 },
      dependencies: { ...platform.dependencies, createSyncClient },
    });
    await Effect.runPromise(
      withJoinedLifecycle((lifecycle) =>
        Effect.gen(function* () {
          const receipt = yield* Deferred.make<void>();
          yield* Effect.forkScoped(lifecycle.runCommand(() => Deferred.await(receipt)));
          yield* Effect.sleep(10);
          platform.emitSync({ ...platform.sync.getSnapshot(), connection: { phase: "connecting" } });
          yield* Effect.sleep(400);
          expect(lifecycle.getSnapshot()).toMatchObject({ state: "reconnecting", failure: { recoverable: true } });
          expect(stopMedia).not.toHaveBeenCalled();
          platform.emitSync({ ...platform.sync.getSnapshot(), connection: { phase: "live" } });
          yield* Effect.sleep(400);
          expect(lifecycle.getSnapshot()).toMatchObject({ state: "live", failure: null });
          expect(createSyncClient).toHaveBeenCalledTimes(1);
          yield* Deferred.succeed(receipt, undefined);
        }),
      ).pipe(Effect.scoped, Effect.provide(layer)),
    );
  });

  it("does not flash reconnecting for a transport recovery inside the grace period", async () => {
    const platform = createCoreTestPlatform();
    const layer = testLifecycleLayer({ access: async () => parseParsedAccessGrant(opaqueAccessGrant(1)), dependencies: platform.dependencies });
    await Effect.runPromise(
      withJoinedLifecycle((lifecycle) =>
        Effect.gen(function* () {
          const states: string[] = [];
          const unsubscribe = lifecycle.subscribe(() => states.push(lifecycle.getSnapshot().state));
          platform.emitSync({ ...platform.sync.getSnapshot(), connection: { phase: "connecting" } });
          yield* Effect.sleep(50);
          platform.emitSync({ ...platform.sync.getSnapshot(), connection: { phase: "live" } });
          yield* Effect.sleep(300);
          expect(states).not.toContain("reconnecting");
          expect(lifecycle.getSnapshot().state).toBe("live");
          unsubscribe();
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

  it.each(["none", "factory", "start"] as const)("recovers custom Sync adapters when replacement failure is %s", async (failure) => {
    const platform = createCoreTestPlatform();
    let creations = 0;
    let starts = 0;
    const createSyncClient = vi.fn(() => {
      if (++creations === 2 && failure === "factory") throw new Error("Temporary transport factory failure");
      return {
        ...platform.sync,
        start: async () => {
          if (++starts === 2 && failure === "start") {
            platform.emitSync({ ...platform.sync.getSnapshot(), connection: { phase: "connecting" } });
            throw new Error("Temporary transport startup failure");
          }
          await platform.sync.start();
        },
      };
    });
    const layer = testLifecycleLayer({ access: async () => parseParsedAccessGrant(opaqueAccessGrant(1)), dependencies: { ...platform.dependencies, createSyncClient }, recovery: { budgetMs: 500, maxAttempts: 3, backoffMs: [10] } });
    await Effect.runPromise(
      withJoinedLifecycle((lifecycle) =>
        Effect.gen(function* () {
          platform.emitSync({ ...platform.sync.getSnapshot(), connection: { phase: "terminal", terminalReason: "fixture_disconnect" } });
          yield* Effect.promise(() => vi.waitFor(() => expect(createSyncClient).toHaveBeenCalledTimes(failure === "none" ? 2 : 3)));
          yield* Effect.promise(() => vi.waitFor(() => expect(lifecycle.getSnapshot()).toMatchObject({ state: "live", connection: { sync: "healthy" }, failure: null })));
        }),
      ).pipe(Effect.provide(layer)),
    );
  });

  it("settles terminally when Sync confirms Participant access is inactive", async () => {
    const platform = createCoreTestPlatform();
    const layer = testLifecycleLayer({ access: async () => parseParsedAccessGrant(opaqueAccessGrant(1)), dependencies: platform.dependencies });
    await Effect.runPromise(
      withJoinedLifecycle((lifecycle) =>
        Effect.gen(function* () {
          platform.emitSync({ ...platform.sync.getSnapshot(), connection: { phase: "terminal", terminalReason: "participant_inactive" } });
          yield* Effect.sleep(50);
          expectAccessRevoked(lifecycle);
        }),
      ).pipe(Effect.provide(layer)),
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
    const layer = testLifecycleLayer({
      access: async () => access,
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
    const layer = testLifecycleLayer({
      access: async () => access,
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

function pendingVoid() {
  let resolve = () => {};
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
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
