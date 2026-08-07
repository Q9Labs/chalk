import { Effect, ManagedRuntime } from "effect";
import { describe, expect, it, vi } from "vitest";
import { ConnectionLifecycleService } from "../connection";
import { ConnectionPlatformService } from "../connection/dependencies";
import { ConnectionError } from "../connection/types";
import { episodeDiagnosticsForConnection, episodeDiagnosticsForDependencies, episodeDiagnosticsForSyncClient } from "./episode-diagnostic-registry";
import { makeSpaceClientCoreLayer, SpaceClientCoreService } from "./core";
import { createCoreTestPlatform, opaqueAccessGrant } from "./core.test.helpers";
import { observeFirstRenderedFrame } from "../../../react/src/internal/episode-diagnostic-render-observer";

describe("SpaceClientCore episode diagnostics integration", () => {
  it("connects lifecycle, rotating grants, remote rendering, and scoped cleanup", async () => {
    const grants = [opaqueAccessGrant(1), opaqueAccessGrant(1, "rotated")];
    const getAccess = vi.fn(async () => grants.shift() ?? opaqueAccessGrant(1, "fallback"));
    const fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { events: readonly { eventId: string }[] };
      return Response.json({
        diagnosticReference: "chalkdiag:v1:integration",
        committedCursor: body.events.length,
        accepted: body.events.map((event, index) => ({ eventId: event.eventId, cursor: index + 1 })),
        duplicates: [],
        conflicts: [],
      });
    });
    const platform = integrationPlatform();
    const runtime = ManagedRuntime.make(makeSpaceClientCoreLayer({ space: "demo", getAccess }, { ...platform, fetch }));
    const core = runtime.runSync(Effect.service(SpaceClientCoreService));
    const lifecycle = runtime.runSync(Effect.service(ConnectionLifecycleService));
    const dependencies = runtime.runSync(Effect.service(ConnectionPlatformService));
    const diagnostics = episodeDiagnosticsForConnection(lifecycle);

    expect(diagnostics).toBeDefined();
    await runtime.runPromise(core.join({ microphone: false, camera: false }));
    expect(episodeDiagnosticsForSyncClient(platform.sync)).toBe(diagnostics);

    let attempts = 0;
    await runtime.runPromise(
      lifecycle.runPortCommand(() => {
        attempts += 1;
        return attempts === 1 ? Effect.fail(new ConnectionError({ code: "invalid_access", action: null, recoverable: true, message: "expired" })) : Effect.succeed(undefined);
      }),
    );
    expect(getAccess).toHaveBeenCalledTimes(2);
    expect(diagnostics?.inspect().credentialGeneration).toBe(1);
    expect(diagnostics?.inspect().ring).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "access.request", state: "succeeded" }),
        expect.objectContaining({ name: "access.refresh", state: "succeeded" }),
        expect.objectContaining({ name: "participant.join", state: "succeeded" }),
        expect.objectContaining({ name: "sync.connect", state: "succeeded" }),
      ]),
    );

    const track = { id: "remote-camera-1" } as unknown as MediaStreamTrack;
    platform.media.emit({
      ...platform.media.getSnapshot(),
      remoteTracks: [{ participantId: "participant-remote", source: "camera", publicationId: "camera-1", track }],
    });
    await vi.waitFor(() => expect(core.getSnapshot().media.remote).toEqual([expect.objectContaining({ track })]));

    const renderRegistry = (globalThis as unknown as Record<symbol, WeakMap<object, unknown>>)[Symbol.for("@chalk/private/episode-diagnostic-render-registry/v1")];
    expect(renderRegistry?.get(track)).toBeDefined();
    const replacement = { id: "remote-camera-2" } as unknown as MediaStreamTrack;
    platform.media.emit({
      ...platform.media.getSnapshot(),
      remoteTracks: [{ participantId: "participant-remote", source: "camera", publicationId: "camera-1", track: replacement }],
    });
    await vi.waitFor(() => expect(core.getSnapshot().media.remote).toEqual([expect.objectContaining({ track: replacement })]));
    expect(renderRegistry?.get(track)).toBeUndefined();
    expect(renderRegistry?.get(replacement)).toBeDefined();

    platform.media.emit({ ...platform.media.getSnapshot(), remoteTracks: [] });
    await vi.waitFor(() => expect(core.getSnapshot().media.remote).toEqual([]));
    expect(renderRegistry?.get(replacement)).toBeUndefined();

    platform.media.emit({
      ...platform.media.getSnapshot(),
      remoteTracks: [{ participantId: "participant-remote", source: "camera", publicationId: "camera-1", track }],
    });
    await vi.waitFor(() => expect(renderRegistry?.get(track)).toBeDefined());

    let frameCallback: (() => void) | undefined;
    observeFirstRenderedFrame({ requestVideoFrameCallback: (callback: () => void) => ((frameCallback = callback), 1) } as unknown as HTMLVideoElement, track);
    frameCallback?.();
    expect(diagnostics?.inspect().ring).toEqual(expect.arrayContaining([expect.objectContaining({ name: "camera.publish", phase: "first_frame", state: "observed" })]));

    await runtime.dispose();
    expect(episodeDiagnosticsForConnection(lifecycle)).toBeUndefined();
    expect(episodeDiagnosticsForDependencies(dependencies)).toBeUndefined();
    expect(episodeDiagnosticsForSyncClient(platform.sync)).toBeUndefined();
    expect(diagnostics?.inspect()).toMatchObject({ ring: [], queue: [], credentialGeneration: null });
    expect(fetch).toHaveBeenCalled();
  });
});

function integrationPlatform() {
  return createCoreTestPlatform();
}
