import { Effect, ManagedRuntime } from "effect";
import { describe, expect, it, vi } from "vitest";
import { makeSpaceClientCoreLayer, SpaceClientCoreService, type SpaceClientPlatform } from "./core";
import { createCoreTestPlatform, opaqueAccessGrant } from "./core.test.helpers";

describe("SpaceClientCore", () => {
  it("constructs as a scoped native service with an idle snapshot", async () => {
    const runtime = ManagedRuntime.make(
      makeSpaceClientCoreLayer({
        space: "demo",
        getAccess: async () => {
          throw new Error("not joined");
        },
      }),
    );
    const core = runtime.runSync(Effect.service(SpaceClientCoreService));

    expect(core.getSnapshot().connection.status).toBe("idle");
    await runtime.dispose();
  });

  it("prefers the platform connection-access bridge without widening public GetAccess", async () => {
    const connectionAccess = vi.fn<NonNullable<SpaceClientPlatform["connectionAccess"]>>(async () => opaqueAccessGrant("bridge"));
    const getAccess = vi.fn(async () => Promise.reject(new Error("The public access callback must not run")));
    const runtime = ManagedRuntime.make(makeSpaceClientCoreLayer({ space: "demo", getAccess }, platformWithConnectionAccess(connectionAccess)));
    const core = runtime.runSync(Effect.service(SpaceClientCoreService));

    await runtime.runPromise(core.join({ microphone: false, camera: false }));

    expect(connectionAccess).toHaveBeenCalledWith(expect.objectContaining({ reason: "join", replaceMediaConnection: false }));
    expect(getAccess).not.toHaveBeenCalled();
    await runtime.dispose();
  });

  it("falls back to the public access context when no platform bridge is installed", async () => {
    const getAccess = vi.fn(async () => opaqueAccessGrant("public"));
    const runtime = ManagedRuntime.make(makeSpaceClientCoreLayer({ space: "demo", getAccess }, platformWithConnectionAccess()));
    const core = runtime.runSync(Effect.service(SpaceClientCoreService));

    await runtime.runPromise(core.join({ microphone: false, camera: false }));

    expect(getAccess).toHaveBeenCalledWith({ space: "demo", reason: "join" });
    await runtime.dispose();
  });
});

function platformWithConnectionAccess(connectionAccess?: NonNullable<SpaceClientPlatform["connectionAccess"]>): SpaceClientPlatform {
  const platform = createCoreTestPlatform();
  return {
    whiteboardUrl: null,
    ...(connectionAccess ? { connectionAccess } : {}),
    dependencies: platform.dependencies,
  };
}
