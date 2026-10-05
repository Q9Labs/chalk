import { Deferred, Effect, Fiber } from "effect";
import { describe, expect, it, vi } from "vitest";

import { parseParsedAccessGrant } from "../access/grant";
import { ConnectionAccessFailure } from "../access/manager";
import { createCoreTestPlatform, opaqueAccessGrant } from "../space-client/core.test.helpers";
import { ConnectionLifecycleService, makeConnectionLifecycleLayer } from "./lifecycle";
import type { ConnectionOptions } from "./index";

describe("ConnectionLifecycle Episode snapshot", () => {
  it("does not block lifecycle loss or other actions behind a long-running upload", async () => {
    const platform = createCoreTestPlatform();
    const layer = testLifecycleLayer({ access: async () => parseParsedAccessGrant(opaqueAccessGrant(1)), dependencies: platform.dependencies, recovery: { budgetMs: 50, maxAttempts: 1 } });
    await Effect.runPromise(
      Effect.gen(function* () {
        const lifecycle = yield* joinedLifecycle();
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
      Effect.gen(function* () {
        const lifecycle = yield* joinedLifecycle();
        yield* Effect.promise(() => vi.waitFor(() => expect(release).toBeDefined()));
        platform.emitSync({ ...platform.sync.getSnapshot(), connection: { phase: "recovering" } });
        yield* Effect.sleep(350);
        const snapshot = lifecycle.getSnapshot();
        release?.();
        expect(snapshot).toMatchObject({ state: "reconnecting", connection: { sync: "recovering" } });
      }).pipe(Effect.provide(layer)),
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
      platform.media.emit({ ...platform.media.getSnapshot(), failure: null, connection: { ...platform.media.getSnapshot().connection, phase: "live" } });
    });
    const layer = testLifecycleLayer({
      access: replacementAccess(),
      dependencies: platform.dependencies,
      recovery: { budgetMs: 1_000, maxAttempts: 1 },
    });
    await Effect.runPromise(
      Effect.gen(function* () {
        const lifecycle = yield* joinedLifecycle();
        platform.media.emit({ ...platform.media.getSnapshot(), failure: { code: "media_failed", recoverable: true }, connection: { ...platform.media.getSnapshot().connection, phase: "failed" } });
        yield* Effect.promise(() => vi.waitFor(() => expect(restart).toHaveBeenCalledOnce()));
        const result = yield* lifecycle.runCommand(() => Effect.succeed("action completed")).pipe(Effect.timeout(100), Effect.result);
        release?.();
        expect(result).toMatchObject({ _tag: "Success", success: "action completed" });
      }).pipe(Effect.provide(layer)),
    );
  });

  it("does not apply the receipt recovery deadline to a healthy long-running port operation", async () => {
    const platform = createCoreTestPlatform();
    const layer = testLifecycleLayer({ access: async () => parseParsedAccessGrant(opaqueAccessGrant(1)), dependencies: platform.dependencies, recovery: { budgetMs: 10 } });
    await Effect.runPromise(
      Effect.gen(function* () {
        const lifecycle = yield* joinedLifecycle();
        const result = yield* lifecycle.runPortCommand(() => Effect.sleep(30).pipe(Effect.as("finalized")));
        expect(result).toBe("finalized");
      }).pipe(Effect.provide(layer)),
    );
  });

  it("reconciles media that failed while Sync Join was still pending", async () => {
    const platform = createCoreTestPlatform();
    const media = testMediaClient(platform);
    const restart = vi.spyOn(media, "restart").mockImplementation(async () => {
      platform.media.emit({ ...platform.media.getSnapshot(), failure: null, connection: { ...platform.media.getSnapshot().connection, phase: "live" } });
    });
    const sync = {
      ...platform.sync,
      start: async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        platform.media.emit({ ...platform.media.getSnapshot(), failure: { code: "media_failed", recoverable: true }, connection: { ...platform.media.getSnapshot().connection, phase: "failed" } });
        await new Promise((resolve) => setTimeout(resolve, 10));
        await platform.sync.start();
      },
    };
    const layer = testLifecycleLayer({
      access: replacementAccess(),
      dependencies: { ...platform.dependencies, createSyncClient: () => sync },
    });
    await Effect.runPromise(
      Effect.gen(function* () {
        const lifecycle = yield* joinedLifecycle();
        yield* Effect.sleep(350);
        expect(restart).toHaveBeenCalledTimes(1);
        expect(lifecycle.getSnapshot()).toMatchObject({ state: "live", connection: { media: "healthy" } });
      }).pipe(Effect.provide(layer)),
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
      Effect.gen(function* () {
        const lifecycle = yield* joinedLifecycle();
        yield* Effect.sleep(200);
        expect(lifecycle.getSnapshot()).toMatchObject({ state: "failed", failure: { code: "invalid_access", recoverable: false } });
      }).pipe(Effect.provide(layer)),
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
      Effect.gen(function* () {
        const lifecycle = yield* joinedLifecycle();
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
      }).pipe(Effect.scoped, Effect.provide(layer)),
    );
  });

  it("does not flash reconnecting for a transport recovery inside the grace period", async () => {
    const platform = createCoreTestPlatform();
    const layer = testLifecycleLayer({ access: async () => parseParsedAccessGrant(opaqueAccessGrant(1)), dependencies: platform.dependencies });
    await Effect.runPromise(
      Effect.gen(function* () {
        const lifecycle = yield* joinedLifecycle();
        const states: string[] = [];
        const unsubscribe = lifecycle.subscribe(() => states.push(lifecycle.getSnapshot().state));
        platform.emitSync({ ...platform.sync.getSnapshot(), connection: { phase: "connecting" } });
        yield* Effect.sleep(50);
        platform.emitSync({ ...platform.sync.getSnapshot(), connection: { phase: "live" } });
        yield* Effect.sleep(300);
        expect(states).not.toContain("reconnecting");
        expect(lifecycle.getSnapshot().state).toBe("live");
        unsubscribe();
      }).pipe(Effect.provide(layer)),
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
      Effect.gen(function* () {
        const lifecycle = yield* joinedLifecycle();
        platform.emitSync({ ...platform.sync.getSnapshot(), connection: { phase: "terminal", terminalReason: "fixture_disconnect" } });
        yield* Effect.promise(() => vi.waitFor(() => expect(createSyncClient).toHaveBeenCalledTimes(failure === "none" ? 2 : 3)));
        yield* Effect.promise(() => vi.waitFor(() => expect(lifecycle.getSnapshot()).toMatchObject({ state: "live", connection: { sync: "healthy" }, failure: null })));
      }).pipe(Effect.provide(layer)),
    );
  });

  it("settles terminally when Sync confirms Participant access is inactive", async () => {
    const platform = createCoreTestPlatform();
    const layer = testLifecycleLayer({ access: async () => parseParsedAccessGrant(opaqueAccessGrant(1)), dependencies: platform.dependencies });
    await Effect.runPromise(
      Effect.gen(function* () {
        const lifecycle = yield* joinedLifecycle();
        platform.emitSync({ ...platform.sync.getSnapshot(), connection: { phase: "terminal", terminalReason: "participant_inactive" } });
        yield* Effect.sleep(50);
        expect(lifecycle.getSnapshot()).toMatchObject({ state: "failed", failure: { code: "invalid_access", recoverable: false } });
      }).pipe(Effect.provide(layer)),
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
