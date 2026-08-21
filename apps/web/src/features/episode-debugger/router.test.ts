import { afterEach, describe, expect, it, vi } from "vitest";

async function loadGetRouter(enabled: boolean, mode: "off" | "localhost" | "hosted") {
  vi.resetModules();
  vi.stubGlobal("__EPISODE_DIAGNOSTICS_ROUTE_ENABLED__", enabled);
  vi.stubGlobal("__EPISODE_DIAGNOSTICS_MODE__", mode);
  return (await import("../../router")).getRouter;
}

describe("Episode Debugger route refusal", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("does not register the route when diagnostics mode is off", async () => {
    const getRouter = await loadGetRouter(false, "off");
    const router = getRouter();

    expect((router.routesByPath as unknown as Record<string, unknown>)["/developer/episode-diagnostics/$reference"]).toBeUndefined();
  });

  it("registers localhost diagnostics outside the authenticated dashboard", async () => {
    const getRouter = await loadGetRouter(true, "localhost");
    const router = getRouter();
    const diagnosticsRoute = Object.values(router.routesByPath).find((route) => route.fullPath === "/developer/episode-diagnostics/$reference");
    if (!diagnosticsRoute) throw new Error("Expected the localhost diagnostics route to be registered.");

    expect(diagnosticsRoute.parentRoute).toBe(router.routeTree);
  });

  it("keeps hosted diagnostics inside the authenticated dashboard", async () => {
    const getRouter = await loadGetRouter(true, "hosted");
    const router = getRouter();
    const diagnosticsRoute = Object.values(router.routesByPath).find((route) => route.fullPath === "/developer/episode-diagnostics/$reference");
    if (!diagnosticsRoute) throw new Error("Expected the hosted diagnostics route to be registered.");
    const dashboardRoute = Object.values(router.routesById).find((route) => route.id === "/_app");
    if (!dashboardRoute) throw new Error("Expected the authenticated dashboard route to be registered.");

    expect(diagnosticsRoute.parentRoute).toBe(dashboardRoute);
  });

  it("keeps one diagnostics route across repeated router creation", async () => {
    const getRouter = await loadGetRouter(true, "localhost");

    const first = getRouter();
    const second = getRouter();

    expect(Object.keys(first.routesByPath).filter((path) => path === "/developer/episode-diagnostics/$reference")).toHaveLength(1);
    expect(Object.keys(second.routesByPath).filter((path) => path === "/developer/episode-diagnostics/$reference")).toHaveLength(1);
  });
});
