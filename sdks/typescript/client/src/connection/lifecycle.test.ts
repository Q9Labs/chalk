import { Deferred, Effect, Fiber } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";

import { parseParsedAccessGrant } from "../access/grant";
import { createCoreTestPlatform, opaqueAccessGrant } from "../space-client/core.test.helpers";
import { ConnectionLifecycleService, makeConnectionLifecycleLayer, type ConnectionLifecycleCapability } from "./lifecycle";

import { ConnectionAccessFailure } from "../access/manager";
import type { ConnectionOptions } from "./index";

describe("ConnectionLifecycle Episode snapshot", () => {
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
});

function credential(audience: "chalk-sync" | "chalk-media"): string {
  const encode = (value: unknown) => btoa(JSON.stringify(value)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
  return `${encode({ alg: "EdDSA" })}.${encode({ aud: audience })}.signature`;
}

describe("ConnectionLifecycle self-healing", () => {
  afterEach(() => vi.restoreAllMocks());

  it.each(["scheduled", "join", "participant_inactive", "stale_participant_generation", "episode_ended", "recovery", "recovery_with_hung_sync"] as const)("records %s evidence before teardown", async (reason) => {
    const f = recoveryFixture();
    const events: string[] = [];
    const record = vi.fn((event: { code: string }) => {
      if (event.code === "reconnect.terminal_failure") events.push("evidence");
    });
    f.options.recordReconnect = record;
    const stop = f.platform.sync.stop;
    vi.spyOn(f.platform.sync, "stop").mockImplementation(() => {
      events.push("stop");
      stop();
    });
    if (reason === "join") vi.spyOn(f.platform.sync, "start").mockImplementation(async () => f.failSync("participant_inactive"));
    const initialStart = f.platform.sync.start;
    if (reason === "recovery_with_hung_sync")
      vi.spyOn(f.platform.sync, "start")
        .mockImplementationOnce(initialStart)
        .mockImplementation(() => {
          f.platform.emitSync({ ...f.platform.sync.getSnapshot(), connection: { phase: "connecting" } });
          return new Promise<void>(() => {});
        });
    await f.run(async (lifecycle) => {
      if (reason === "scheduled" || reason === "recovery" || reason === "recovery_with_hung_sync") {
        if (reason === "recovery_with_hung_sync") {
          f.failSync();
          await f.tick(250);
          await vi.waitFor(() => expect(f.platform.sync.start).toHaveBeenCalledTimes(2));
        }
        f.access.mockRejectedValue(new ConnectionAccessFailure({ code: "access.invalid", cause: "invalid access" }));
        if (reason !== "scheduled") f.mediaPhase("failed");
        await f.tick(reason === "scheduled" ? 3_600_000 : reason === "recovery" ? 250 : 1_000);
      } else if (reason !== "join") f.failSync(reason);
      await vi.waitFor(() => expect(lifecycle.getSnapshot().state).toBe("failed"));
      const code = reason === "episode_ended" ? "episode_ended" : "invalid_access";
      expect(record).toHaveBeenCalledWith(expect.objectContaining({ code: "reconnect.terminal_failure", attributes: { code, terminal_reason: reason === "join" ? "participant_inactive" : ["participant_inactive", "stale_participant_generation", "episode_ended"].includes(reason) ? reason : code } }));
      const teardownsBeforeTerminal = reason === "recovery_with_hung_sync" || reason === "join" ? 1 : 0;
      expect(events.slice(teardownsBeforeTerminal, teardownsBeforeTerminal + 2)).toEqual(["evidence", "stop"]);
    });
  });

  it.each(["success", "rejected"] as const)("keeps uploads independent and rejects %s work after closure", async (outcome) => {
    const f = recoveryFixture();
    const retained = await f.run(async (lifecycle) => {
      const uploaded = await Effect.runPromise(Deferred.make<string, ConnectionAccessFailure>());
      const operation = vi.fn(() => Deferred.await(uploaded));
      const pending = Effect.runPromise(lifecycle.runPortCommand(operation).pipe(Effect.result));
      await vi.waitFor(() => expect(operation).toHaveBeenCalledOnce());
      expect(await Effect.runPromise(lifecycle.runCommand(() => Effect.succeed("action")).pipe(Effect.timeout(100), Effect.result))).toMatchObject({ _tag: "Success", success: "action" });
      f.platform.emitSync({ ...f.platform.sync.getSnapshot(), connection: { phase: "connecting" } });
      await f.tick(250);
      expect(lifecycle.getSnapshot().state).toBe("reconnecting");
      await Effect.runPromise(Deferred.succeed(uploaded, "finalized"));
      expect(await pending).toMatchObject({ _tag: "Success", success: "finalized" });
      const late = await Effect.runPromise(Deferred.make<string, ConnectionAccessFailure>());
      const lateOperation = vi.fn(() => Deferred.await(late));
      const latePending = Effect.runPromise(lifecycle.runPortCommand(lateOperation).pipe(Effect.result));
      await vi.waitFor(() => expect(lateOperation).toHaveBeenCalledOnce());
      return { lifecycle, late, latePending };
    });
    const calls = f.access.mock.calls.length;
    await Effect.runPromise(outcome === "success" ? Deferred.succeed(retained.late, "late") : Deferred.fail(retained.late, new ConnectionAccessFailure({ code: "access.invalid", cause: "late" })));
    expect(await retained.latePending).toMatchObject({ _tag: "Failure", failure: { code: "invalid_state" } });
    const operation = vi.fn(() => Effect.succeed(undefined));
    expect(await Effect.runPromise(retained.lifecycle.runPortCommand(operation).pipe(Effect.result))).toMatchObject({ _tag: "Failure", failure: { code: "invalid_state" } });
    expect(operation).not.toHaveBeenCalled();
    expect(f.access).toHaveBeenCalledTimes(calls);
  });

  it("backs off scheduled refreshes and resets after success", async () => {
    const f = recoveryFixture();
    f.lifetime = 1_000;
    await f.run(async () => {
      f.access.mockRejectedValue(new Error("outage"));
      await f.tick(1_000);
      for (const delay of [5_000, 10_000, 20_000, 40_000, 60_000, 60_000]) {
        await f.wait(delay);
        await f.tick(delay);
      }
      f.access.mockImplementation(f.grant);
      await f.tick(60_000);
      await f.wait(1_000);
      f.access.mockRejectedValue(new Error("outage"));
      await f.tick(1_000);
      await f.wait(5_000);
    });
  });

  it.each(["access", "other_transport", "other_transport_reverse", "other_transport_during_attempt"] as const)("backs off exhausted cycles without dropping %s recovery", async (mode) => {
    const f = recoveryFixture();
    const start = vi.spyOn(f.platform.sync, "start");
    vi.spyOn(f.media, "restart").mockImplementation(async () => f.mediaPhase("live"));
    await f.run(async (lifecycle) => {
      const reverse = mode === "other_transport_reverse";
      const attempts = reverse ? start : f.access;
      if (reverse) {
        start.mockRejectedValue(new Error("outage"));
        f.failSync();
      } else {
        f.access.mockRejectedValue(new Error("outage"));
        f.mediaPhase("failed");
      }
      await f.tick(250);
      const exhausted = () => lifecycle.getDiagnostics().filter((event) => event.event === "recovery_exhausted").length;
      await vi.waitFor(() => expect(exhausted()).toBe(1));
      for (const delay of [250, 500, 1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000]) {
        await f.wait(delay);
        const cycles = exhausted();
        await f.tick(delay);
        await vi.waitFor(() => expect(exhausted()).toBe(cycles + 1));
      }
      await f.wait(60_000);
      if (reverse) {
        start.mockRestore();
        f.mediaPhase("failed");
        await vi.waitFor(() => expect(f.media.restart).toHaveBeenCalledOnce());
      } else if (mode !== "access") {
        let reject = () => {};
        if (mode === "other_transport_during_attempt") {
          const calls = f.access.mock.calls.length;
          f.access.mockImplementationOnce(
            () =>
              new Promise((_, fail) => {
                reject = () => fail(new Error("outage"));
              }),
          );
          await f.tick(60_000);
          await vi.waitFor(() => expect(f.access).toHaveBeenCalledTimes(calls + 1));
        }
        f.failSync();
        if (mode === "other_transport_during_attempt") await vi.waitFor(() => expect(lifecycle.getSnapshot().connection.sync).toBe("failed"));
        reject();
        await vi.waitFor(() => expect(f.platform.sync.getSnapshot().connection.phase).toBe("live"));
      }
      if (mode === "access") {
        f.access.mockImplementation(f.grant);
        await f.tick(60_000);
      } else f.mediaPhase("live");
      await vi.waitFor(() => expect(lifecycle.getSnapshot().state).toBe("live"));
      const calls = attempts.mock.calls.length;
      await f.tick(60_000);
      expect(attempts).toHaveBeenCalledTimes(calls);
    });
  });

  it.each(["expired", "automatic", "native"] as const)("expires %s media recovery without interrupting a fresh generation", async (mode) => {
    const f = recoveryFixture();
    let finish = () => {};
    let replace = async () => (await f.grant()).media;
    const create = f.dependencies.createMediaClient;
    f.dependencies.createMediaClient = (input) => {
      if (input.replaceMediaConnection) replace = input.replaceMediaConnection;
      return create(input);
    };
    const restart = vi
      .spyOn(f.media, "restart")
      .mockImplementationOnce(async () => {
        f.mediaPhase("recovering");
        await new Promise<void>(() => {});
      })
      .mockImplementationOnce(async () => {
        f.mediaPhase("recovering");
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
        f.mediaPhase("live");
      })
      .mockImplementation(async () => f.mediaPhase("live"));
    if (mode === "automatic") {
      const grant = f.grant;
      let calls = 0;
      const expires = f.clock.now() + 55_000;
      f.access.mockImplementation(async () => {
        const access = await grant();
        return { ...access, media: { ...access.media, expiresAt: new Date(++calls < 3 ? expires : f.clock.now() + 3_600_000).toISOString() } };
      });
    }
    await f.run(async (lifecycle) => {
      f.mediaPhase("failed");
      await f.tick(250);
      await vi.waitFor(() => expect(restart).toHaveBeenCalledOnce());
      await f.tick(mode === "expired" ? 60_001 : 54_750);
      const native = mode === "native" ? f.media.restart(await replace()) : Promise.resolve();
      if (mode === "expired") await f.tick(60_000);
      await vi.waitFor(() => expect(restart).toHaveBeenCalledTimes(2));
      await f.tick(10_000);
      expect(restart).toHaveBeenCalledTimes(2);
      finish();
      await native;
      await vi.waitFor(() => expect(lifecycle.getSnapshot().state).toBe("live"));
      await f.tick(60_001);
      f.mediaPhase("recovering");
      await f.tick(250);
      expect(restart).toHaveBeenCalledTimes(2);
    });
  });

  it.each(["late_live", "connecting", "idle"] as const)("owns %s replacement ports independently of media", async (phase) => {
    const f = recoveryFixture();
    let finish = () => {};
    const stop = vi.fn();
    const replacement = {
      ...f.platform.sync,
      stop,
      start: async () => {
        f.platform.emitSync({ ...f.platform.sync.getSnapshot(), connection: { phase: phase === "late_live" ? "connecting" : phase } });
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
        if (phase === "late_live") await f.platform.sync.start();
      },
    };
    const factory = vi.fn().mockReturnValueOnce(f.platform.sync).mockReturnValueOnce(replacement).mockReturnValue(f.platform.sync);
    f.dependencies.createSyncClient = factory;
    await f.run(async (lifecycle) => {
      const observed = vi.fn();
      lifecycle.subscribePorts((ports) => observed(ports?.sync, ports?.sync.getSnapshot().connection.phase));
      f.failSync();
      await f.tick(250);
      await vi.waitFor(() => expect(factory).toHaveBeenCalledTimes(2));
      expect(observed).toHaveBeenCalledWith(replacement, expect.any(String));
      await f.tick(1_000);
      if (phase === "late_live") {
        f.access.mockRejectedValue(new Error("media outage"));
        f.mediaPhase("failed");
        await vi.waitFor(() => expect(lifecycle.getSnapshot().connection.media).toBe("failed"));
        finish();
        await vi.waitFor(() => expect(lifecycle.getSnapshot().connection.sync).toBe("healthy"));
        expect(lifecycle.getSnapshot().connection.media).toBe("failed");
        expect(observed).toHaveBeenLastCalledWith(replacement, "live");
      } else {
        await f.tick(250);
        expect(factory).toHaveBeenCalledTimes(2);
        await f.tick(60_001);
        await f.wait(500);
        await f.tick(500);
        await vi.waitFor(() => expect(factory).toHaveBeenCalledTimes(3));
        expect(stop).toHaveBeenCalledOnce();
        finish();
        await vi.waitFor(() => expect(stop).toHaveBeenCalledTimes(2));
      }
    });
  });

  it("heals media failure during pending Sync Join", async () => {
    const f = recoveryFixture();
    const start = f.platform.sync.start;
    vi.spyOn(f.platform.sync, "start").mockImplementation(async () => {
      f.mediaPhase("failed");
      await start();
    });
    const restart = vi.spyOn(f.media, "restart").mockImplementation(async () => f.mediaPhase("live"));
    await f.run(async (lifecycle) => {
      await f.tick(250);
      await vi.waitFor(() => expect(restart).toHaveBeenCalledOnce());
      expect(lifecycle.getSnapshot().state).toBe("live");
    });
  });
});

function recoveryFixture() {
  vi.spyOn(Math, "random").mockReturnValue(1);
  const platform = createCoreTestPlatform();
  let now = Date.now();
  let next = 0;
  const timers = new Map<number, { at: number; callback: () => void }>();
  const clock = {
    now: () => now,
    setTimeout: (callback: () => void, delay: number) => {
      timers.set(++next, { at: now + delay, callback });
      return next;
    },
    clearTimeout: (id: unknown) => {
      if (typeof id === "number") timers.delete(id);
    },
  };
  const dependencies = { ...platform.dependencies, clock };
  const media = dependencies.createMediaClient({ access: parseParsedAccessGrant(opaqueAccessGrant(1)), credential: async () => "unused", onFailure: () => {}, onScreenEnded: () => {} });
  let grants = 0;
  const grant = async () => {
    const access = opaqueAccessGrant(1);
    const expires_at = new Date(clock.now() + fixture.lifetime).toISOString();
    return parseParsedAccessGrant({ ...access, sync: { ...access.sync, expires_at }, media: { ...access.media, expires_at, client_payload: { connectionId: `replacement-${++grants}`, stunServer: "stun:test" } } });
  };
  const access = vi.fn(grant);
  const options: Omit<ConnectionOptions, "apiBaseURL" | "syncURL"> = { access, dependencies, accessRefreshWindowMs: 0, recovery: { budgetMs: 1_000, maxAttempts: 1 } };
  const fixture = {
    platform,
    dependencies,
    options,
    clock,
    media,
    grant,
    access,
    lifetime: 3_600_000,
    mediaPhase: (phase: "live" | "recovering" | "failed") => {
      const snapshot = platform.media.getSnapshot();
      platform.media.emit({ ...snapshot, failure: phase === "failed" ? { code: "media_failed", recoverable: true } : null, connection: { ...snapshot.connection, phase } });
    },
    failSync: (terminalReason = "fixture_disconnect") => platform.emitSync({ ...platform.sync.getSnapshot(), connection: { phase: "terminal", terminalReason } }),
    wait: (delay: number) => vi.waitFor(() => expect([...timers.values()].some((timer) => timer.at === now + delay)).toBe(true)),
    tick: async (delay: number) => {
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
      now += delay;
      for (const [id, timer] of timers) {
        if (timer.at <= now) {
          timers.delete(id);
          timer.callback();
        }
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
    },
    run: <A>(exercise: (lifecycle: ConnectionLifecycleCapability) => Promise<A>) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const lifecycle = yield* Effect.service(ConnectionLifecycleService);
          yield* lifecycle.join().pipe(Effect.result);
          return yield* Effect.promise(() => exercise(lifecycle));
        }).pipe(Effect.scoped, Effect.provide(makeConnectionLifecycleLayer({ apiBaseURL: "https://api.chalk.test", syncURL: "wss://sync.chalk.test/v1/sync", ...options }))),
      ),
  };
  return fixture;
}
