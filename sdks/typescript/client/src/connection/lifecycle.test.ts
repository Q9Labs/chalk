import { Deferred, Effect, Fiber } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSpaceClientForPlatform } from "../space-client/space-client";
import { parseParsedAccessGrant } from "../access/grant";
import { createCoreTestPlatform, opaqueAccessGrant } from "../space-client/core.test.helpers";
import { ConnectionLifecycleService, makeConnectionLifecycleLayer, type ConnectionLifecycleCapability } from "./lifecycle";
import { ConnectionAccessFailure } from "../access/manager";
import type { ConnectionOptions } from "./index";
describe("ConnectionLifecycle Episode snapshot", () => {
  it.each(["startup", "live"] as const)("surfaces a failed digest recovery during %s without replacing the Sync client", async (phase) => {
    const fixture = recoveryFixture();
    const createSync = vi.spyOn(fixture.dependencies, "createSyncClient");
    if (phase === "startup") vi.spyOn(fixture.platform.sync, "start").mockImplementation(async () => fixture.failSync("state_digest_recovery_failed"));
    await fixture.run(async (lifecycle) => {
      if (phase === "live") {
        expect(lifecycle.getSnapshot().state).toBe("live");
        fixture.failSync("state_digest_recovery_failed");
      }
      await vi.waitFor(() => expect(lifecycle.getSnapshot()).toMatchObject({ state: "failed", failure: { code: "state_digest_recovery_failed", recoverable: false } }));
      await fixture.tick(60000);
      expect(createSync).toHaveBeenCalledTimes(1);
      expect(lifecycle.getSnapshot()).toMatchObject({ state: "failed", failure: { code: "state_digest_recovery_failed", recoverable: false } });
    });
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
  it("retains a redacted dial-timeout diagnostic after Sync recovers without duplicate events", async () => {
    const platform = createCoreTestPlatform();
    const layer = makeConnectionLifecycleLayer({
      access: async () => parseParsedAccessGrant(opaqueAccessGrant("dial-diagnostic")),
      apiBaseURL: "https://api.chalk.test",
      syncURL: "wss://sync.chalk.test/v1/sync",
      dependencies: platform.dependencies,
    });
    await Effect.runPromise(
      Effect.gen(function* () {
        const lifecycle = yield* Effect.service(ConnectionLifecycleService);
        yield* lifecycle.join();
        const live = platform.sync.getSnapshot();
        platform.emitSync({ ...live, connection: { phase: "connecting", dialTimeoutCount: 1 } });
        platform.emitSync({ ...live, connection: { phase: "live", dialTimeoutCount: 1 } });
        platform.emitSync({ ...live, connection: { phase: "live", dialTimeoutCount: 1 } });
        expect(lifecycle.getDiagnostics().filter((event) => event.event === "sync_dial_timeout")).toEqual([{ timestamp: expect.any(Number), event: "sync_dial_timeout", state: "live", epoch: expect.any(Number), attempt: 1 }]);
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
function recoveryFixture() {
  vi.spyOn(Math, "random").mockReturnValue(1);
  const platform = createCoreTestPlatform();
  let now = Date.now();
  let next = 0;
  const timers = new Map<
    number,
    {
      at: number;
      callback: () => void;
    }
  >();
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
  const options: Omit<ConnectionOptions, "apiBaseURL" | "syncURL"> = { access, dependencies, accessRefreshWindowMs: 0, recovery: { budgetMs: 1000, maxAttempts: 1 } };
  const fixture = {
    platform,
    dependencies,
    options,
    clock,
    media,
    grant,
    access,
    lifetime: 3600000,
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

function admissionLayer(options: Pick<ConnectionOptions, "access" | "dependencies">) {
  return makeConnectionLifecycleLayer({ apiBaseURL: "https://api.chalk.test", syncURL: "wss://sync.chalk.test/v1/sync", ...options });
}
function exerciseAdmission<A, E>(layer: ReturnType<typeof admissionLayer>, exercise: (lifecycle: ConnectionLifecycleCapability) => Effect.Effect<A, E>) {
  return Effect.runPromise(
    Effect.gen(function* () {
      const lifecycle = yield* Effect.service(ConnectionLifecycleService);
      return yield* exercise(lifecycle);
    }).pipe(Effect.provide(layer), Effect.scoped),
  );
}
function blockedSync(platform: ReturnType<typeof createCoreTestPlatform>) {
  return {
    ...platform.sync,
    start: async () => {
      throw new Error("blocked socket");
    },
  };
}

describe("failed join admission cleanup", () => {
  it("re-admits a cancelled seat instead of trying to refresh it after access rejection", async () => {
    const platform = createCoreTestPlatform();
    const grant = parseParsedAccessGrant(opaqueAccessGrant(1));
    let cancelled = false;
    let rejectAccess = true;
    const layer = admissionLayer({
      access: async ({ reason }) => {
        if (reason === "join") cancelled = false;
        if (cancelled) throw new Error("A cancelled admission cannot refresh access");
        return grant;
      },
      dependencies: {
        ...platform.dependencies,
        cancelPendingAdmission: async () => {
          cancelled = true;
          return true;
        },
        createSyncClient: () => {
          if (rejectAccess) {
            rejectAccess = false;
            throw new ConnectionAccessFailure({ code: "access.invalid", cause: "rejected token" });
          }
          return platform.sync;
        },
      },
    });
    await exerciseAdmission(layer, (lifecycle) =>
      Effect.gen(function* () {
        expect((yield* Effect.exit(lifecycle.join()))._tag).toBe("Success");
      }),
    );
  });

  it("can retry the same confirmed seat when media fails after hello", async () => {
    const platform = createCoreTestPlatform();
    const grant = parseParsedAccessGrant(opaqueAccessGrant(1));
    let seat: "pending" | "joined" | "left" = "pending";
    let attempts = 0;
    let confirmHello!: () => void;
    const hello = new Promise<void>((resolve) => {
      confirmHello = resolve;
    });
    const layer = admissionLayer({
      access: async () => {
        if (seat === "left") throw new Error("The idempotent join is terminal");
        return grant;
      },
      dependencies: {
        ...platform.dependencies,
        cancelPendingAdmission: async () => seat !== "joined",
        createSyncClient: () => ({
          ...platform.sync,
          start: async () => {
            seat = "joined";
            await platform.sync.start();
            confirmHello();
          },
          leave: async () => {
            seat = "left";
            return platform.sync.leave();
          },
        }),
        createMediaClient: (input) => ({
          ...platform.dependencies.createMediaClient(input),
          start: async () => {
            await hello;
            if (attempts++ === 0) throw new Error("Media signaling failed after hello");
          },
        }),
      },
    });
    await exerciseAdmission(layer, (lifecycle) =>
      Effect.gen(function* () {
        expect((yield* Effect.exit(lifecycle.join()))._tag).toBe("Failure");
        expect((yield* Effect.exit(lifecycle.join()))._tag).toBe("Success");
        yield* lifecycle.leave();
        expect(seat).toBe("left");
      }),
    );
  });

  it("cancels the admitted seat before discarding access when Sync startup fails", async () => {
    const platform = createCoreTestPlatform();
    const grant = parseParsedAccessGrant(opaqueAccessGrant(1));
    const cancelled: string[] = [];
    const layer = admissionLayer({
      access: async () => grant,
      dependencies: {
        ...platform.dependencies,
        cancelPendingAdmission: async (access) => {
          cancelled.push(access.subject.participantId);
          return true;
        },
        createSyncClient: () => blockedSync(platform),
      },
    });
    await exerciseAdmission(layer, (lifecycle) =>
      Effect.gen(function* () {
        const result = yield* Effect.exit(lifecycle.join());
        expect(result._tag).toBe("Failure");
        expect(cancelled).toEqual([grant.subject.participantId]);
      }),
    );
  });
});

it("keeps failed HTTP cleanup unconfirmed so local Leave cannot clear a retry identity", async () => {
  const platform = createCoreTestPlatform();
  const layer = admissionLayer({
    access: async () => parseParsedAccessGrant(opaqueAccessGrant(1)),
    dependencies: {
      ...platform.dependencies,
      cancelPendingAdmission: async () => {
        throw new Error("offline");
      },
      createSyncClient: () => blockedSync(platform),
    },
  });
  await exerciseAdmission(layer, (lifecycle) =>
    Effect.gen(function* () {
      expect((yield* Effect.exit(lifecycle.join()))._tag).toBe("Failure");
      expect((yield* Effect.exit(lifecycle.leave()))._tag).toBe("Failure");
      expect((yield* Effect.exit(lifecycle.leave()))._tag).toBe("Failure");
      expect(lifecycle.getSnapshot().failure?.code).toBe("leave_unconfirmed");
    }),
  );
});
