import { Deferred, Effect } from "effect";
import { describe, expect, it, vi } from "vitest";

import { parseParsedAccessGrant } from "../access/grant";
import { ConnectionAccessFailure } from "../access/manager";
import { createCoreTestPlatform, opaqueAccessGrant } from "../space-client/core.test.helpers";
import { ConnectionLifecycleService, makeConnectionLifecycleLayer } from "./lifecycle";

describe("ConnectionLifecycle Episode snapshot", () => {
  it("stops recovery when the access provider explicitly revokes Participant access", async () => {
    const platform = createCoreTestPlatform();
    const initial = opaqueAccessGrant(1);
    const access = parseParsedAccessGrant({ ...initial, sync: { ...initial.sync, expires_at: new Date(Date.now() + 100).toISOString() } });
    let reads = 0;
    const layer = makeConnectionLifecycleLayer({
      access: async () => {
        if (reads++ > 0) throw new ConnectionAccessFailure({ code: "access.invalid", cause: new Error("Participant access revoked") });
        return access;
      },
      accessRefreshWindowMs: 0,
      apiBaseURL: "https://api.chalk.test",
      syncURL: "wss://sync.chalk.test/v1/sync",
      dependencies: platform.dependencies,
    });
    await Effect.runPromise(
      Effect.gen(function* () {
        const lifecycle = yield* Effect.service(ConnectionLifecycleService);
        yield* lifecycle.join();
        yield* Effect.sleep(200);
        expect(lifecycle.getSnapshot()).toMatchObject({ state: "failed", failure: { code: "invalid_access", recoverable: false } });
      }).pipe(Effect.provide(layer)),
    );
  });
  it("processes loss while an action is awaiting its receipt and heals after the foreground budget", async () => {
    const platform = createCoreTestPlatform();
    const createSyncClient = vi.fn(() => platform.sync);
    const stopMedia = vi.spyOn(platform.dependencies.createMediaClient({ access: parseParsedAccessGrant(opaqueAccessGrant(1)), credential: async () => "unused", onFailure: () => undefined, onScreenEnded: () => undefined }), "stop");
    const layer = makeConnectionLifecycleLayer({
      access: async () => parseParsedAccessGrant(opaqueAccessGrant(1)),
      apiBaseURL: "https://api.chalk.test",
      syncURL: "wss://sync.chalk.test/v1/sync",
      recovery: { budgetMs: 50, maxAttempts: 1 },
      dependencies: { ...platform.dependencies, createSyncClient },
    });
    await Effect.runPromise(
      Effect.gen(function* () {
        const lifecycle = yield* Effect.service(ConnectionLifecycleService);
        yield* lifecycle.join();
        const receipt = yield* Deferred.make<void>();
        yield* Effect.forkScoped(lifecycle.runCommand(() => Deferred.await(receipt)));
        yield* Effect.sleep(10);
        platform.sync.emit({ ...platform.sync.getSnapshot(), connection: { phase: "connecting" } });
        yield* Effect.sleep(400);
        expect(lifecycle.getSnapshot()).toMatchObject({ state: "reconnecting", failure: { recoverable: true } });
        expect(stopMedia).not.toHaveBeenCalled();
        platform.sync.emit({ ...platform.sync.getSnapshot(), connection: { phase: "live" } });
        yield* Effect.sleep(400);
        expect(lifecycle.getSnapshot()).toMatchObject({ state: "live", failure: null });
        expect(createSyncClient).toHaveBeenCalledTimes(1);
        yield* Deferred.succeed(receipt, undefined);
      }).pipe(Effect.scoped, Effect.provide(layer)),
    );
  });

  it("does not flash reconnecting for a transport recovery inside the grace period", async () => {
    const platform = createCoreTestPlatform();
    const layer = makeConnectionLifecycleLayer({ access: async () => parseParsedAccessGrant(opaqueAccessGrant(1)), apiBaseURL: "https://api.chalk.test", syncURL: "wss://sync.chalk.test/v1/sync", dependencies: platform.dependencies });
    await Effect.runPromise(
      Effect.gen(function* () {
        const lifecycle = yield* Effect.service(ConnectionLifecycleService);
        yield* lifecycle.join();
        const states: string[] = [];
        const unsubscribe = lifecycle.subscribe(() => states.push(lifecycle.getSnapshot().state));
        platform.sync.emit({ ...platform.sync.getSnapshot(), connection: { phase: "connecting" } });
        yield* Effect.sleep(50);
        platform.sync.emit({ ...platform.sync.getSnapshot(), connection: { phase: "live" } });
        yield* Effect.sleep(300);
        expect(states).not.toContain("reconnecting");
        expect(lifecycle.getSnapshot().state).toBe("live");
        unsubscribe();
      }).pipe(Effect.provide(layer)),
    );
  });

  it("settles terminally when Sync confirms Participant access is inactive", async () => {
    const platform = createCoreTestPlatform();
    const layer = makeConnectionLifecycleLayer({ access: async () => parseParsedAccessGrant(opaqueAccessGrant(1)), apiBaseURL: "https://api.chalk.test", syncURL: "wss://sync.chalk.test/v1/sync", dependencies: platform.dependencies });
    await Effect.runPromise(
      Effect.gen(function* () {
        const lifecycle = yield* Effect.service(ConnectionLifecycleService);
        yield* lifecycle.join();
        platform.sync.emit({ ...platform.sync.getSnapshot(), connection: { phase: "terminal", terminalReason: "participant_inactive" } });
        yield* Effect.sleep(50);
        expect(lifecycle.getSnapshot()).toMatchObject({ state: "failed", failure: { code: "invalid_access", recoverable: false } });
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
