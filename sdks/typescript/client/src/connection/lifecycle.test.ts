import { Deferred, Effect, Fiber, Layer, ManagedRuntime } from "effect";
import { TestClock } from "effect/testing";
import type { CloudflareSFUBootstrap, CloudflareSFUSnapshot } from "../media";
import type { V1EpisodeSnapshot } from "../sync";
import type { JourneyTelemetryContext } from "../telemetry/types";
import { describe, expect, it } from "vitest";
import { ConnectionAccessFailure, ConnectionAccessService, makeConnectionAccessLayer } from "../access/manager";
import { accessGrant } from "../access/grant.test.helpers";
import { ConnectionLifecycleService, makeConnectionLifecycleLayerFromServices } from "./lifecycle";
import { makeConnectionPlatformLayer, type ConnectionAccessRequest, type ConnectionDependencies, type ConnectionMediaClient, type ConnectionSyncClient } from "./dependencies";
import { ConnectionError } from "./types";

const START = Date.parse("2026-08-04T12:00:00.000Z");

describe("ConnectionLifecycleService", () => {
  it("refreshes R1 access on the native TestClock schedule", async () => {
    const grants = [accessGrant(START + 61_000, "first"), accessGrant(START + 300_000, "second")];
    const harness = makeHarness(() => Effect.sync(() => grants.shift()!));

    await startHarness(harness);
    await harness.runtime.runPromise(TestClock.adjust(1_000));
    await settle(harness);

    expect(harness.requests).toHaveLength(2);
    expect(harness.lifecycle.getSnapshot()).toMatchObject({ state: "live", subject: { participantId: "participant-1" } });
    await harness.runtime.dispose();
  });

  it("passes the active journey context through the Sync factory seam", async () => {
    const telemetry: JourneyTelemetryContext = {
      journeyId: "00000000-0000-4000-8000-000000000001",
      rootJourneyId: "00000000-0000-4000-8000-000000000001",
      traceparent: "00-11111111111111111111111111111111-2222222222222222-01",
      tracestate: "chalk=sync",
    };
    const harness = makeHarness(() => Effect.succeed(accessGrant(START + 300_000, "telemetry")), { telemetry });

    await startHarness(harness);

    expect(harness.syncTelemetries[0]).toEqual(telemetry);
    await harness.runtime.dispose();
  });

  it("serializes commands through the Queue and rejects after scope closure", async () => {
    const harness = makeHarness(() => Effect.succeed(accessGrant(START + 300_000, "stable")));
    const values: string[] = [];

    await harness.runtime.runPromise(harness.lifecycle.join());
    await harness.runtime.runPromise(harness.lifecycle.runCommand(() => Effect.sync(() => values.push("first"))));
    await harness.runtime.runPromise(harness.lifecycle.runCommand(() => Effect.sync(() => values.push("second"))));
    expect(values).toEqual(["first", "second"]);

    await harness.runtime.dispose();
    await expect(Effect.runPromise(harness.lifecycle.runCommand(() => Effect.void))).rejects.toMatchObject({ _tag: "ConnectionLifecycleFailure", code: "invalid_state" });
  });

  it("revalidates foreground work and retries one rejected command through R1", async () => {
    const grants = [accessGrant(START + 300_000, "first"), accessGrant(START + 300_000, "foreground"), accessGrant(START + 300_000, "retry")];
    const harness = makeHarness(() => Effect.sync(() => grants.shift()!));
    let attempts = 0;

    await startHarness(harness);
    harness.foreground();
    await settle(harness);
    await harness.runtime.runPromise(
      harness.lifecycle.runCommand(() => {
        attempts += 1;
        return attempts === 1 ? Effect.fail(new ConnectionError({ code: "invalid_access", action: null, recoverable: true, message: "expired" })) : Effect.void;
      }),
    );

    expect(harness.requests).toHaveLength(2);
    expect(attempts).toBe(2);
    await harness.runtime.dispose();
  });

  it("interrupts a pending Join before it asks for access, then finalizes its scope", async () => {
    const gate = Deferred.makeUnsafe<MediaStream>();
    const harness = makeHarness(() => Effect.fail(new ConnectionAccessFailure({ code: "access.unavailable", cause: new Error("unreachable") })));
    harness.runtime.runSync(harness.lifecycle.setInitialMedia(() => Deferred.await(gate)));

    const join = harness.runtime.runFork(harness.lifecycle.join());
    await settle(harness);
    expect(harness.lifecycle.getSnapshot().state).toBe("joining");
    await harness.runtime.runPromise(harness.lifecycle.leave());
    const exit = await Effect.runPromise(Effect.exit(Fiber.join(join)));

    expect(exit._tag).toBe("Failure");
    expect(harness.requests).toEqual([]);
    expect(harness.lifecycle.getSnapshot().state).toBe("left");
    await harness.runtime.dispose();
  });

  it("attributes media permission failures before requesting access", async () => {
    const harness = makeHarness(() => Effect.succeed(accessGrant(START + 300_000, "unused")));
    harness.runtime.runSync(harness.lifecycle.setInitialMedia(() => Effect.fail(new DOMException("denied", "NotAllowedError"))));

    await expect(harness.runtime.runPromise(harness.lifecycle.join())).rejects.toMatchObject({ _tag: "ConnectionLifecycleFailure", code: "permission_denied" });

    expect(harness.requests).toEqual([]);
    expect(harness.lifecycle.getSnapshot()).toMatchObject({ state: "failed", failure: { code: "permission_denied" } });
    expect(harness.lifecycle.getJoinTrace()).toContainEqual(expect.objectContaining({ step: "acquire_initial_media", outcome: "failed" }));
    await harness.runtime.dispose();
  });

  it("attributes startup failures, stops created ports, and permits a clean rejoin", async () => {
    const mediaFailure = fakeMedia({ startError: new Error("media startup failed") });
    const mediaFailureHarness = makeHarness(() => Effect.succeed(accessGrant(START + 300_000, "media-failure")), { mediaFactory: () => mediaFailure });

    await expect(mediaFailureHarness.runtime.runPromise(mediaFailureHarness.lifecycle.join())).rejects.toMatchObject({ code: "media_start_failed" });
    expect(mediaFailure.stops).toBe(1);
    expect(mediaFailureHarness.syncs[0]?.stops).toBe(1);
    expect(mediaFailureHarness.lifecycle.getSnapshot()).toMatchObject({ state: "failed", failure: { code: "media_start_failed" } });
    await mediaFailureHarness.runtime.dispose();

    const firstMedia = fakeMedia();
    const secondMedia = fakeMedia();
    const rejectedSync = fakeSync({ startError: new Error("sync startup failed") });
    const replacementSync = fakeSync();
    const syncFailureHarness = makeHarness(() => Effect.succeed(accessGrant(START + 300_000, "sync-failure")), {
      mediaFactory: (index) => [firstMedia, secondMedia][index]!,
      syncFactory: (index) => [rejectedSync, replacementSync][index]!,
    });

    await expect(syncFailureHarness.runtime.runPromise(syncFailureHarness.lifecycle.join())).rejects.toMatchObject({ code: "sync_start_failed" });
    expect(firstMedia.stops).toBe(1);
    expect(rejectedSync.stops).toBe(1);
    await syncFailureHarness.runtime.runPromise(syncFailureHarness.lifecycle.join());

    expect(syncFailureHarness.lifecycle.getSnapshot().state).toBe("live");
    expect(secondMedia.starts).toBe(1);
    expect(replacementSync.starts).toBe(1);
    await syncFailureHarness.runtime.dispose();
  });

  it("distinguishes durable Leave acknowledgement from an Episode-end confirmation", async () => {
    const unconfirmedSync = fakeSync({ leaveError: new Error("leave lost") });
    const unconfirmed = makeHarness(() => Effect.succeed(accessGrant(START + 300_000, "unconfirmed")), { syncFactory: () => unconfirmedSync });

    await unconfirmed.runtime.runPromise(unconfirmed.lifecycle.join());
    await expect(unconfirmed.runtime.runPromise(unconfirmed.lifecycle.leave())).rejects.toMatchObject({ code: "leave_unconfirmed" });
    expect(unconfirmedSync.leaveCalls).toBe(1);
    expect(unconfirmed.lifecycle.getSnapshot()).toMatchObject({ state: "left", failure: { code: "leave_unconfirmed" } });
    await unconfirmed.runtime.dispose();

    const endedSync = fakeSync({ leaveError: new Error("must not invoke leave") });
    const ended = makeHarness(() => Effect.succeed(accessGrant(START + 300_000, "episode-ended")), { syncFactory: () => endedSync });

    await ended.runtime.runPromise(ended.lifecycle.join());
    ended.runtime.runSync(ended.lifecycle.confirmEpisodeEnded);
    await ended.runtime.runPromise(ended.lifecycle.leave());

    expect(endedSync.leaveCalls).toBe(0);
    expect(ended.lifecycle.getSnapshot()).toMatchObject({ state: "left", failure: null });
    await ended.runtime.dispose();
  });

  it("recreates Sync after a terminal transition and restores the live lifecycle", async () => {
    const original = fakeSync();
    const replacement = fakeSync();
    const harness = makeHarness(() => Effect.succeed(accessGrant(START + 300_000, "sync-recovery")), {
      syncFactory: (index) => [original, replacement][index]!,
      recovery: { budgetMs: 100, maxAttempts: 3, backoffMs: [10] },
    });

    await startHarness(harness);
    original.emit(syncSnapshot("terminal", "participant-1"));
    await settle(harness);

    expect(harness.syncs).toHaveLength(2);
    expect(original.stops).toBeGreaterThanOrEqual(1);
    expect(harness.lifecycle.getSnapshot().state).toBe("live");
    expect(harness.lifecycle.getDiagnostics()).toEqual(expect.arrayContaining([expect.objectContaining({ event: "recovery_attempt", attempt: 1 }), expect.objectContaining({ event: "recovery_succeeded", attempt: 1 })]));
    await harness.runtime.dispose();
  });

  it("coalesces startup snapshots before evaluating Sync recovery", async () => {
    const sync = fakeSync({ startPhases: ["connecting", "recovering", "live"] });
    const harness = makeHarness(() => Effect.succeed(accessGrant(START + 300_000, "sync-startup")), { syncFactory: () => sync });

    await startHarness(harness);
    await settle(harness);

    expect(harness.syncs).toHaveLength(1);
    expect(sync.stops).toBe(0);
    expect(harness.lifecycle.getSnapshot().state).toBe("live");
    expect(harness.lifecycle.getDiagnostics().filter((event) => event.event === "recovery_attempt")).toEqual([]);
    await harness.runtime.dispose();
  });

  it("coalesces repeated media recovery signals from the same active port", async () => {
    const initial = accessGrant(START + 300_000, "coalesced-initial");
    const replacement = accessGrant(START + 300_000, "coalesced-replacement", "connection-2");
    const { harness, media } = mediaRecoveryHarness(initial, replacement);

    await startHarness(harness);
    media.emit(mediaSnapshot("failed", true));
    media.emit(mediaSnapshot("failed", true));
    await settle(harness);

    expect(media.restarts).toEqual([replacement.media.clientPayload]);
    expect(harness.requests).toHaveLength(2);
    expect(harness.lifecycle.getDiagnostics().filter((event) => event.event === "recovery_attempt")).toHaveLength(1);
    expect(harness.lifecycle.getSnapshot().state).toBe("live");
    await harness.runtime.dispose();
  });

  it("backs off after a synchronous Sync recovery failure and succeeds without duplicate teardown", async () => {
    const original = fakeSync();
    const replacement = fakeSync();
    let factoryCalls = 0;
    const harness = makeHarness(() => Effect.succeed(accessGrant(START + 300_000, "sync-backoff")), {
      syncFactory: () => {
        factoryCalls += 1;
        if (factoryCalls === 1) return original;
        if (factoryCalls === 2) throw new Error("first recovery factory failure");
        return replacement;
      },
      recovery: { budgetMs: 500, maxAttempts: 2, backoffMs: [50] },
    });

    await startHarness(harness);
    original.emit(syncSnapshot("terminal", "participant-1"));
    await settle(harness);

    expect(harness.lifecycle.getSnapshot().state).toBe("reconnecting");
    expect(factoryCalls).toBe(2);
    await harness.runtime.runPromise(TestClock.adjust(49));
    await settle(harness);
    expect(factoryCalls).toBe(2);
    expect(harness.medias[0]?.stops).toBe(0);

    await harness.runtime.runPromise(TestClock.adjust(1));
    await settle(harness);

    expect(factoryCalls).toBe(3);
    expect(original.stops).toBe(1);
    expect(harness.medias[0]?.stops).toBe(0);
    expect(harness.lifecycle.getSnapshot().state).toBe("live");
    expect(harness.lifecycle.getDiagnostics()).toEqual(expect.arrayContaining([expect.objectContaining({ event: "recovery_attempt", attempt: 1 }), expect.objectContaining({ event: "recovery_attempt", attempt: 2 }), expect.objectContaining({ event: "recovery_succeeded", attempt: 2 })]));
    await harness.runtime.dispose();
    expect(original.stops).toBe(1);
    expect(original.unsubscribes).toBe(1);
    expect(replacement.stops).toBe(1);
    expect(harness.medias[0]?.stops).toBe(1);
  });

  it("recovers media with a replacement-media access grant", async () => {
    const initial = accessGrant(START + 300_000, "media-initial", "connection-1");
    const replacement = accessGrant(START + 300_000, "media-replacement", "connection-2");
    const { harness, media } = mediaRecoveryHarness(initial, replacement);

    await startHarness(harness);
    media.emit(mediaSnapshot("failed", true));
    await settle(harness);

    expect(harness.requests[1]).toEqual({ reason: "media_recovery", replaceMediaConnection: true, currentMediaToken: initial.media.token, expectedParticipantGeneration: 1 });
    expect(media.restarts).toEqual([replacement.media.clientPayload]);
    expect(harness.lifecycle.getSnapshot()).toMatchObject({ state: "live", subject: { participantId: "participant-1" } });
    await harness.runtime.dispose();
  });

  it("exhausts the recovery budget, tears down ports, and clears access", async () => {
    const original = fakeSync();
    const stalled = fakeSync({ startLive: false });
    const harness = makeHarness(() => Effect.succeed(accessGrant(START + 300_000, "recovery-exhausted")), {
      syncFactory: (index) => [original, stalled][index]!,
      recovery: { budgetMs: 100, maxAttempts: 1 },
    });

    await startHarness(harness);
    original.emit(syncSnapshot("terminal", "participant-1"));
    await settle(harness);
    await harness.runtime.runPromise(TestClock.adjust(100));
    await settle(harness);

    expect(harness.lifecycle.getSnapshot()).toMatchObject({ state: "failed", subject: null, failure: { code: "sync_recovery_exhausted" } });
    expect(harness.medias[0]?.stops).toBeGreaterThanOrEqual(1);
    expect(stalled.stops).toBeGreaterThanOrEqual(1);
    await expect(harness.runtime.runPromise(harness.access.current)).resolves.toBeNull();
    expect(harness.lifecycle.getDiagnostics()).toContainEqual(expect.objectContaining({ event: "recovery_exhausted", code: "sync_recovery_exhausted" }));
    await harness.runtime.dispose();
  });

  it("reschedules an access refresh after a refresh failure", async () => {
    const first = accessGrant(START + 61_000, "first");
    const recovered = accessGrant(START + 300_000, "recovered");
    const harness = makeHarness(() => {
      if (harness.requests.length === 1) return Effect.succeed(first);
      if (harness.requests.length === 2) return Effect.fail(new ConnectionAccessFailure({ code: "access.unavailable", cause: new Error("temporary outage") }));
      return Effect.succeed(recovered);
    });

    await startHarness(harness);
    await harness.runtime.runPromise(TestClock.adjust(1_000));
    await settle(harness);
    expect(harness.lifecycle.getDiagnostics()).toContainEqual(expect.objectContaining({ event: "access_refresh_failed" }));

    await harness.runtime.runPromise(TestClock.adjust(5_000));
    await settle(harness);

    expect(harness.requests).toHaveLength(3);
    expect(harness.lifecycle.getDiagnostics()).toContainEqual(expect.objectContaining({ event: "access_refreshed" }));
    await harness.runtime.dispose();
  });

  it("publishes lifecycle transitions and finalizes ports, subscriptions, and access", async () => {
    const media = fakeMedia();
    const sync = fakeSync();
    const harness = makeHarness(() => Effect.succeed(accessGrant(START + 300_000, "finalizers")), { mediaFactory: () => media, syncFactory: () => sync });
    const states: string[] = [];
    const ports: unknown[] = [];
    const unsubscribeSnapshot = harness.lifecycle.subscribe(() => states.push(harness.lifecycle.getSnapshot().state));
    const unsubscribePorts = harness.lifecycle.subscribePorts((value) => ports.push(value));

    await harness.runtime.runPromise(harness.lifecycle.join());
    await harness.runtime.runPromise(harness.lifecycle.leave());
    unsubscribeSnapshot();
    unsubscribePorts();

    expect(states).toEqual(expect.arrayContaining(["joining", "live", "leaving", "left"]));
    expect(ports[0]).toBeNull();
    expect(ports).toContainEqual(expect.objectContaining({ sync: sync.client, media: media.client }));
    expect(ports.at(-1)).toBeNull();
    expect(sync.unsubscribes).toBeGreaterThanOrEqual(1);
    expect(media.unsubscribes).toBeGreaterThanOrEqual(1);
    expect(sync.stops).toBe(1);
    expect(media.stops).toBe(1);
    await expect(harness.runtime.runPromise(harness.access.current)).resolves.toBeNull();
    expect(harness.lifecycle.getSnapshot()).toMatchObject({ state: "left", subject: null, episode: null });
    expect(harness.lifecycle.getDiagnostics()).toEqual(expect.arrayContaining([expect.objectContaining({ event: "cleanup_completed" }), expect.objectContaining({ event: "state_changed", state: "left" })]));
    await harness.runtime.dispose();
  });
});

type HarnessOptions = {
  readonly mediaFactory?: (index: number) => FakeMedia;
  readonly syncFactory?: (index: number) => FakeSync;
  readonly telemetry?: JourneyTelemetryContext;
  readonly recovery?: { readonly budgetMs?: number; readonly maxAttempts?: number; readonly backoffMs?: readonly number[] };
};

type Harness = {
  readonly requests: ConnectionAccessRequest[];
  readonly medias: FakeMedia[];
  readonly syncs: FakeSync[];
  readonly syncTelemetries: (JourneyTelemetryContext | undefined)[];
  readonly access: ContextService<ConnectionAccessService>;
  readonly lifecycle: ContextService<ConnectionLifecycleService>;
  readonly runtime: ManagedRuntime.ManagedRuntime<ConnectionAccessService | ConnectionLifecycleService, never>;
  readonly foreground: () => void;
};

type ContextService<Service extends { readonly _tag: string }> = Service extends { readonly Service: infer Value } ? Value : never;

function makeHarness(provider: Parameters<typeof makeConnectionAccessLayer>[0], options: HarnessOptions = {}): Harness {
  const requests: ConnectionAccessRequest[] = [];
  const medias: FakeMedia[] = [];
  const syncs: FakeSync[] = [];
  const syncTelemetries: (JourneyTelemetryContext | undefined)[] = [];
  let foregroundListener: (() => void) | undefined;
  const dependencies: ConnectionDependencies = {
    clock: { now: () => START, setTimeout: (callback, milliseconds) => setTimeout(callback, milliseconds), clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>) },
    mediaDevices: { getUserMedia: async () => stream(), getDisplayMedia: async () => stream() },
    createMediaClient: () => {
      const media = options.mediaFactory?.(medias.length) ?? fakeMedia();
      medias.push(media);
      return media.client;
    },
    createSyncClient: (input) => {
      syncTelemetries.push(input.telemetry);
      const sync = options.syncFactory?.(syncs.length) ?? fakeSync();
      syncs.push(sync);
      return sync.client;
    },
    createId: () => "test-id",
    subscribeForeground: (listener) => {
      foregroundListener = listener;
      return () => {
        if (foregroundListener === listener) foregroundListener = undefined;
      };
    },
  };
  const accessLayer = makeConnectionAccessLayer((request) => {
    requests.push(request);
    return provider(request);
  });
  const lifecycleLayer = makeConnectionLifecycleLayerFromServices({ apiBaseURL: "https://api.test", syncURL: "wss://sync.test/v1", telemetry: options.telemetry, ...(options.recovery ? { recovery: options.recovery } : {}) }).pipe(
    Layer.provideMerge(Layer.mergeAll(accessLayer, makeConnectionPlatformLayer(dependencies), TestClock.layer({ warningDelay: "1 hour" }))),
  );
  const runtime = ManagedRuntime.make(lifecycleLayer);
  return {
    requests,
    medias,
    syncs,
    syncTelemetries,
    access: runtime.runSync(Effect.service(ConnectionAccessService)),
    lifecycle: runtime.runSync(Effect.service(ConnectionLifecycleService)),
    runtime,
    foreground: () => foregroundListener?.(),
  };
}

async function settle(harness: Harness, turns = 6): Promise<void> {
  for (let turn = 0; turn < turns; turn += 1) await harness.runtime.runPromise(Effect.yieldNow);
}

type FakeMedia = {
  readonly client: ConnectionMediaClient;
  readonly starts: number;
  readonly stops: number;
  readonly restarts: readonly CloudflareSFUBootstrap[];
  readonly unsubscribes: number;
  emit: (snapshot: CloudflareSFUSnapshot) => void;
};

function fakeMedia(options: { readonly startError?: unknown } = {}): FakeMedia {
  let snapshot = mediaSnapshot("idle");
  let starts = 0;
  let stops = 0;
  let unsubscribes = 0;
  const restarts: CloudflareSFUBootstrap[] = [];
  const listeners = new Set<() => void>();
  const emit = (next: CloudflareSFUSnapshot) => {
    snapshot = next;
    for (const listener of listeners) listener();
  };
  const client = {
    start: async () => {
      starts += 1;
      if (options.startError) throw options.startError;
      emit(mediaSnapshot("live"));
    },
    stop: () => {
      stops += 1;
    },
    restart: async (bootstrap: CloudflareSFUBootstrap) => {
      restarts.push(bootstrap);
      emit(mediaSnapshot("live"));
    },
    prepareLocalTrack: () => undefined,
    clearPreparedLocalTrack: async () => undefined,
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        if (listeners.delete(listener)) unsubscribes += 1;
      };
    },
  } as ConnectionMediaClient;
  return {
    client,
    get starts() {
      return starts;
    },
    get stops() {
      return stops;
    },
    restarts,
    get unsubscribes() {
      return unsubscribes;
    },
    emit,
  };
}

type FakeSync = {
  readonly client: ConnectionSyncClient;
  readonly starts: number;
  readonly stops: number;
  readonly leaveCalls: number;
  readonly unsubscribes: number;
  emit: (snapshot: V1EpisodeSnapshot) => void;
};

function fakeSync(options: { readonly startError?: unknown; readonly startLive?: boolean; readonly startPhases?: readonly V1EpisodeSnapshot["connection"]["phase"][]; readonly leaveError?: unknown } = {}): FakeSync {
  let snapshot = syncSnapshot("idle");
  let starts = 0;
  let stops = 0;
  let leaveCalls = 0;
  let unsubscribes = 0;
  const listeners = new Set<(value: V1EpisodeSnapshot) => void>();
  const emit = (next: V1EpisodeSnapshot) => {
    snapshot = next;
    for (const listener of listeners) listener(snapshot);
  };
  const client = {
    start: async () => {
      starts += 1;
      if (options.startError) throw options.startError;
      if (options.startPhases) {
        for (const phase of options.startPhases) emit(syncSnapshot(phase));
      } else if (options.startLive !== false) {
        emit(syncSnapshot("live"));
      }
    },
    stop: () => {
      stops += 1;
    },
    leave: async () => {
      leaveCalls += 1;
      if (options.leaveError) throw options.leaveError;
      return { type: "ack", command_id: "command-1", outcome: "satisfied", revision: 1, state_digest: "digest" };
    },
    getSnapshot: () => snapshot,
    subscribe: (listener: (value: V1EpisodeSnapshot) => void) => {
      listeners.add(listener);
      return () => {
        if (listeners.delete(listener)) unsubscribes += 1;
      };
    },
  } as unknown as ConnectionSyncClient;
  return {
    client,
    get starts() {
      return starts;
    },
    get stops() {
      return stops;
    },
    get leaveCalls() {
      return leaveCalls;
    },
    get unsubscribes() {
      return unsubscribes;
    },
    emit,
  };
}

function mediaSnapshot(phase: CloudflareSFUSnapshot["connection"]["phase"], recoverable = false): CloudflareSFUSnapshot {
  return {
    connection: { phase, peerConnectionState: null, iceConnectionState: null },
    cursor: null,
    localTracks: [],
    remoteTracks: [],
    failure: phase === "failed" ? { code: "media_failed", recoverable } : null,
  };
}

async function startHarness(harness: ReturnType<typeof makeHarness>): Promise<void> {
  await harness.runtime.runPromise(TestClock.setTime(START));
  await harness.runtime.runPromise(harness.lifecycle.join());
}

function mediaRecoveryHarness(initial: ReturnType<typeof accessGrant>, replacement: ReturnType<typeof accessGrant>) {
  const media = fakeMedia();
  const harness = makeHarness(() => Effect.sync(() => (harness.requests.length === 1 ? initial : replacement)), { mediaFactory: () => media });
  return { harness, media };
}

function syncSnapshot(phase: V1EpisodeSnapshot["connection"]["phase"], participantId: string | null = phase === "idle" ? null : "participant-1"): V1EpisodeSnapshot {
  return {
    connection: { phase },
    participantId,
    participantGeneration: participantId ? 1 : null,
    control: null,
    optimisticControl: null,
    media: null,
    presence: null,
    mediaPlane: { local: [], remote: [] },
    localMedia: { microphone: "unknown", camera: "unknown", screen: "unknown" },
    pendingCommandCount: 0,
  };
}

function stream(): MediaStream {
  return { getTracks: () => [] } as MediaStream;
}
