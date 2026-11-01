import { Deferred, Effect, Fiber } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSpaceClientForPlatform } from "../space-client/space-client";
import { parseParsedAccessGrant } from "../access/grant";
import { createCoreTestPlatform, opaqueAccessGrant } from "../space-client/core.test.helpers";
import { ConnectionLifecycleService, makeConnectionLifecycleLayer, type ConnectionLifecycleCapability } from "./lifecycle";
import { ConnectionAccessFailure } from "../access/manager";
import type { ConnectionOptions } from "./index";
import { CloudflareSFUError, createCloudflareSFUHTTPTransport } from "../media";
import { streamFromTracks } from "./media-devices";

beforeEach(() => vi.stubGlobal("fetch", async () => new Response(null, { status: 204 })));
afterEach(() => vi.unstubAllGlobals());

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
function blockedAdmission(cancelPendingAdmission: NonNullable<ConnectionOptions["dependencies"]>["cancelPendingAdmission"]) {
  const platform = createCoreTestPlatform();
  return admissionLayer({
    access: async () => parseParsedAccessGrant(opaqueAccessGrant(1)),
    dependencies: {
      ...platform.dependencies,
      cancelPendingAdmission,
      createSyncClient: () => ({
        ...platform.sync,
        start: async () => {
          throw new Error("blocked socket");
        },
      }),
    },
  });
}

function rejectFirstAccess(platform: ReturnType<typeof createCoreTestPlatform>) {
  let rejected = false;
  return () => {
    if (!rejected) {
      rejected = true;
      throw new ConnectionAccessFailure({ code: "access.invalid", cause: "rejected provider connection" });
    }
    return platform.sync;
  };
}

describe("failed join admission cleanup", () => {
  it.each([
    { status: 401, initialStarter: false },
    { status: 403, initialStarter: false },
    { status: 401, initialStarter: true },
    { status: 403, initialStarter: true },
  ])("refreshes rejected media access without a manual retry ($status, initialStarter=$initialStarter)", async ({ status, initialStarter }) => {
    const platform = createCoreTestPlatform();
    const requests: string[] = [];
    let mediaRequests = 0;
    const transport = createCloudflareSFUHTTPTransport({
      apiBaseURL: "http://localhost:8080",
      tenantId: "tenant-1",
      spaceId: "space-1",
      episodeId: "episode-1",
      participantId: "participant-1",
      credential: async () => "fixture",
      fetch: async () => (++mediaRequests === 1 ? new Response(null, { status }) : Response.json({ incarnation: 1, sequence: 0, publications: [] })),
    });
    const layer = admissionLayer({
      access: async ({ reason }) => {
        requests.push(reason);
        return parseParsedAccessGrant(opaqueAccessGrant(requests.length));
      },
      dependencies: {
        ...platform.dependencies,
        cancelPendingAdmission: async () => false,
        createMediaClient: (input) => {
          const media = platform.dependencies.createMediaClient(input);
          return {
            ...media,
            start: async (stream) => {
              await transport.listPublications();
              await media.start(stream);
            },
          };
        },
      },
    });
    await exerciseAdmission(layer, (lifecycle) =>
      Effect.gen(function* () {
        if (initialStarter)
          yield* lifecycle.setInitialMedia(
            () => Effect.succeed(streamFromTracks([])),
            undefined,
            (media, stream) => Effect.tryPromise({ try: () => media.start(stream), catch: (cause) => cause }),
          );
        yield* lifecycle.join();
        expect(requests).toEqual(["join", "access_retry"]);
        expect(mediaRequests).toBe(2);
        expect(lifecycle.getSnapshot()).toMatchObject({ state: "live", failure: null });
      }),
    );
  });

  it.each([401, 403, 503])("bounds media access retry and preserves other startup failures (HTTP %s)", async (status) => {
    const platform = createCoreTestPlatform();
    const requests: string[] = [];
    const transport = createCloudflareSFUHTTPTransport({
      apiBaseURL: "http://localhost:8080",
      tenantId: "tenant-1",
      spaceId: "space-1",
      episodeId: "episode-1",
      participantId: "participant-1",
      credential: async () => "fixture",
      fetch: async () => new Response(null, { status }),
    });
    const layer = admissionLayer({
      access: async ({ reason }) => {
        requests.push(reason);
        return parseParsedAccessGrant(opaqueAccessGrant(requests.length));
      },
      dependencies: {
        ...platform.dependencies,
        cancelPendingAdmission: async () => false,
        createMediaClient: (input) => ({
          ...platform.dependencies.createMediaClient(input),
          start: async () => {
            await transport.listPublications();
          },
        }),
      },
    });
    await exerciseAdmission(layer, (lifecycle) =>
      Effect.gen(function* () {
        const result = yield* Effect.exit(lifecycle.join());
        expect(result._tag).toBe("Failure");
        expect(requests).toEqual(status === 503 ? ["join"] : ["join", "access_retry"]);
        expect(lifecycle.getSnapshot()).toMatchObject({ state: "failed", failure: { code: status === 503 ? "media_start_failed" : "invalid_access" } });
      }),
    );
  });

  it("re-admits a cancelled seat instead of trying to refresh it after access rejection", async () => {
    const platform = createCoreTestPlatform();
    const grant = parseParsedAccessGrant(opaqueAccessGrant(1));
    let cancelled = false;
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
        createSyncClient: rejectFirstAccess(platform),
      },
    });
    await exerciseAdmission(layer, (lifecycle) =>
      Effect.gen(function* () {
        expect((yield* Effect.exit(lifecycle.join()))._tag).toBe("Success");
      }),
    );
  });

  it.each([false, undefined])("replaces rejected legacy access when cancellation is %s", async (cancelled) => {
    const platform = createCoreTestPlatform();
    const requests: { reason: string; replaceMediaConnection: boolean }[] = [];
    const layer = admissionLayer({
      access: async ({ reason, replaceMediaConnection }) => {
        requests.push({ reason, replaceMediaConnection });
        return parseParsedAccessGrant(opaqueAccessGrant(requests.length));
      },
      dependencies: {
        ...platform.dependencies,
        cancelPendingAdmission: cancelled === undefined ? undefined : async () => cancelled,
        createSyncClient: rejectFirstAccess(platform),
      },
    });
    await exerciseAdmission(layer, (lifecycle) =>
      Effect.gen(function* () {
        yield* lifecycle.join();
        expect(requests).toEqual([
          { reason: "join", replaceMediaConnection: false },
          { reason: "access_retry", replaceMediaConnection: true },
        ]);
      }),
    );
  });

  it("cancels failed SFU entry after hello and confirms only the successful retry", async () => {
    const platform = createCoreTestPlatform();
    const grant = parseParsedAccessGrant(opaqueAccessGrant(1));
    let seat: "pending" | "joined" | "cancelled" | "left" = "pending";
    let attempts = 0;
    let confirmHello!: () => void;
    const hello = new Promise<void>((resolve) => {
      confirmHello = resolve;
    });
    const layer = admissionLayer({
      access: async () => {
        if (seat === "left") throw new Error("The idempotent join is terminal");
        if (seat === "cancelled") seat = "pending";
        return grant;
      },
      dependencies: {
        ...platform.dependencies,
        cancelPendingAdmission: async () => {
          if (seat !== "pending") return false;
          seat = "cancelled";
          return true;
        },
        createSyncClient: () => ({
          ...platform.sync,
          start: async () => {
            await platform.sync.start();
            confirmHello();
          },
          confirmEntered: async () => {
            seat = "joined";
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
        expect(seat).toBe("cancelled");
        expect((yield* Effect.exit(lifecycle.join()))._tag).toBe("Success");
        expect(seat).toBe("joined");
        yield* lifecycle.leave();
        expect(seat).toBe("left");
      }),
    );
  });

  it("cancels the admitted seat before discarding access when Sync startup fails", async () => {
    const grant = parseParsedAccessGrant(opaqueAccessGrant(1));
    const cancelled: string[] = [];
    const layer = blockedAdmission(async (access) => {
      cancelled.push(access.subject.participantId);
      return true;
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
  const layer = blockedAdmission(async () => {
    throw new Error("offline");
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

it("confirms entry only after Sync is live and SFU startup has completed", async () => {
  const platform = createCoreTestPlatform();
  let releaseMedia!: () => void;
  const mediaReady = new Promise<void>((resolve) => {
    releaseMedia = resolve;
  });
  let entered = 0;
  const layer = makeConnectionLifecycleLayer({
    apiBaseURL: "https://api.chalk.test",
    syncURL: "wss://sync.chalk.test/v1/sync",
    access: async () => parseParsedAccessGrant(opaqueAccessGrant(1)),
    dependencies: {
      ...platform.dependencies,
      createMediaClient: (input) => ({
        ...platform.dependencies.createMediaClient(input),
        start: async () => {
          await mediaReady;
        },
      }),
      createSyncClient: () => ({
        ...platform.sync,
        confirmEntered: async () => {
          expect(platform.sync.getSnapshot().connection.phase).toBe("live");
          entered += 1;
        },
      }),
    },
  });
  await Effect.runPromise(
    Effect.gen(function* () {
      const lifecycle = yield* Effect.service(ConnectionLifecycleService);
      const joining = Effect.runPromise(lifecycle.join());
      for (let i = 0; i < 50; i++) {
        if (platform.sync.getSnapshot().connection.phase === "live") break;
        yield* Effect.sleep("1 millis");
      }
      expect(platform.sync.getSnapshot().connection.phase).toBe("live");
      expect(entered).toBe(0);
      releaseMedia();
      yield* Effect.promise(() => joining);
      expect(entered).toBe(1);
      expect(lifecycle.getSnapshot().state).toBe("live");
    }).pipe(Effect.provide(layer), Effect.scoped),
  );
});

it("fails a late entry timeout as retryable without reconnecting the expired seat", async () => {
  const platform = createCoreTestPlatform();
  let syncClients = 0;
  const layer = admissionLayer({
    access: async () => parseParsedAccessGrant(opaqueAccessGrant(1)),
    dependencies: {
      ...platform.dependencies,
      createSyncClient: () => {
        syncClients += 1;
        return platform.sync;
      },
    },
  });
  await exerciseAdmission(layer, (lifecycle) =>
    Effect.gen(function* () {
      yield* lifecycle.join();
      platform.emitSync({ ...platform.sync.getSnapshot(), connection: { phase: "terminal", terminalReason: "entry_timeout" } });
      yield* Effect.sleep("20 millis");
      expect(lifecycle.getSnapshot()).toMatchObject({ state: "failed", failure: { code: "sync_start_failed", recoverable: true } });
      expect(syncClients).toBe(1);
    }),
  );
});

it("refreshes rejected access during entry confirmation instead of retrying the old credential", async () => {
  const platform = createCoreTestPlatform();
  const reasons: string[] = [];
  let attempts = 0;
  const layer = admissionLayer({
    access: async ({ reason }) => {
      reasons.push(reason);
      return parseParsedAccessGrant(opaqueAccessGrant(reasons.length));
    },
    dependencies: {
      ...platform.dependencies,
      cancelPendingAdmission: async () => false,
      createSyncClient: () => ({
        ...platform.sync,
        confirmEntered: async () => {
          if (attempts++ === 0) throw Object.assign(new Error("Policy rejected"), { code: "access.invalid" });
        },
      }),
    },
  });
  await exerciseAdmission(layer, (lifecycle) =>
    Effect.gen(function* () {
      yield* lifecycle.join();
      expect(reasons).toEqual(["join", "access_retry"]);
      expect(lifecycle.getSnapshot().state).toBe("live");
    }),
  );
});

it("joins through a 5.x custom Sync adapter that has no confirmEntered", async () => {
  const platform = createCoreTestPlatform();
  const { confirmEntered: _confirmEntered, ...legacySync } = platform.sync;
  const cancelPendingAdmission = vi.fn(async () => true);
  const layer = admissionLayer({
    access: async () => parseParsedAccessGrant(opaqueAccessGrant(1)),
    dependencies: { ...platform.dependencies, cancelPendingAdmission, createSyncClient: () => legacySync },
  });
  await exerciseAdmission(layer, (lifecycle) =>
    Effect.gen(function* () {
      yield* lifecycle.join();
      expect(lifecycle.getSnapshot()).toMatchObject({ state: "live", failure: null });
      expect(cancelPendingAdmission).not.toHaveBeenCalled();
    }),
  );
});
