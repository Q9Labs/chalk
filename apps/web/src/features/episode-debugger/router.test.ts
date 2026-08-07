import { afterEach, describe, expect, it, vi } from "vitest";

describe("Episode Debugger route refusal", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("does not register the route when diagnostics mode is off", async () => {
    vi.resetModules();
    vi.stubGlobal("__EPISODE_DIAGNOSTICS_ROUTE_ENABLED__", false);
    const { getRouter } = await import("../../router");
    const router = getRouter();

    expect((router.routesByPath as unknown as Record<string, unknown>)["/developer/episode-diagnostics/$reference"]).toBeUndefined();
  });

  it("registers the route when diagnostics mode is on", async () => {
    vi.resetModules();
    vi.stubGlobal("__EPISODE_DIAGNOSTICS_ROUTE_ENABLED__", true);
    const { getRouter } = await import("../../router");
    const router = getRouter();

    expect((router.routesByPath as unknown as Record<string, unknown>)["/developer/episode-diagnostics/$reference"]).toBeDefined();
  });
});
