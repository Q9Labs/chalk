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

  it("keeps one diagnostics route across repeated router creation", async () => {
    vi.resetModules();
    vi.stubGlobal("__EPISODE_DIAGNOSTICS_ROUTE_ENABLED__", true);
    const { getRouter } = await import("../../router");

    const first = getRouter();
    const second = getRouter();

    expect(Object.keys(first.routesByPath).filter((path) => path === "/developer/episode-diagnostics/$reference")).toHaveLength(1);
    expect(Object.keys(second.routesByPath).filter((path) => path === "/developer/episode-diagnostics/$reference")).toHaveLength(1);
  });
});
