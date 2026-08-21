import { describe, expect, it, vi } from "vitest";
import type { ProxyOptions, UserConfig } from "vite";

const apiOriginEnv = "CHALK_DEV_API_ORIGIN";
const webPortEnv = "CHALK_DEV_WEB_PORT";
const diagnosticsModeEnv = "CHALK_EPISODE_DIAGNOSTICS";
const chalkEnvironmentEnv = "CHALK_ENVIRONMENT";
const operatorTokenEnv = "CHALK_EPISODE_DIAGNOSTICS_OPERATOR_TOKEN";
const diagnosticsGatewayEnv = "CHALK_EPISODE_DIAGNOSTICS_GATEWAY";
const apiUrlEnv = "CHALK_API_URL";

describe("public API Vite proxy", () => {
  it.each([
    [{}, "http://127.0.0.1:8080"],
    [{ [apiOriginEnv]: "https://api.example.test" }, "https://api.example.test"],
  ])(
    "uses the configured API target %#",
    async (environment, target) => {
      const config = await loadViteConfig(environment);
      const proxy = publicAPIProxy(config);

      expect(proxy.target).toBe(target);
      expect(proxy.changeOrigin).toBe(true);
    },
    30_000,
  );

  it("sets the browser origin on public API requests", async () => {
    const config = await loadViteConfig({ [webPortEnv]: "3123" });
    const proxy = publicAPIProxy(config);
    let proxyRequestListener: ((proxyRequest: { setHeader: (name: string, value: string) => void }) => void) | undefined;
    const on = (event: string, listener: (proxyRequest: { setHeader: (name: string, value: string) => void }) => void) => {
      if (event === "proxyReq") proxyRequestListener = listener;
    };

    proxy.configure?.({ on } as never, proxy);

    expect(proxyRequestListener).toEqual(expect.any(Function));
    const setHeader = vi.fn();
    proxyRequestListener?.({ setHeader });

    expect(setHeader).toHaveBeenCalledWith("origin", "http://127.0.0.1:3123");
    expect(config.server?.port).toBe(3123);
  });

  it("keeps the production default web port when no local port is configured", async () => {
    const config = await loadViteConfig({});

    expect(config.server?.port).toBe(3070);
  });
});

describe("Episode Diagnostics Vite boundary", () => {
  it("omits the route and proxy by default", async () => {
    const config = await loadViteConfig({});

    expect(config.define?.__EPISODE_DIAGNOSTICS_ROUTE_ENABLED__).toBe("false");
    expect((config.server?.proxy as Record<string, unknown> | undefined)?.["/_internal/episode-diagnostics"]).toBeUndefined();
  });

  it("injects the localhost operator token only inside the Node proxy", async () => {
    const config = await loadViteConfig({
      [diagnosticsModeEnv]: "localhost",
      [operatorTokenEnv]: "diagnostics-operator-token-for-test",
      [apiUrlEnv]: "http://127.0.0.1:9191",
    });
    const proxy = diagnosticsProxy(config);
    const { setHeader } = invokeProxyRequest(proxy);

    expect(proxy.target).toBe("http://127.0.0.1:9191");
    expect(setHeader).toHaveBeenCalledWith("authorization", "Bearer diagnostics-operator-token-for-test");
    expect(JSON.stringify(config.define)).not.toContain("diagnostics-operator-token-for-test");
    expect(config.define?.__EPISODE_DIAGNOSTICS_ROUTE_ENABLED__).toBe("true");
  });

  it("refuses localhost mode without the Node-only operator token", async () => {
    await expect(loadViteConfig({ [diagnosticsModeEnv]: "localhost" })).rejects.toThrow("CHALK_EPISODE_DIAGNOSTICS_OPERATOR_TOKEN");
  });

  it("refuses to send the operator token to a non-loopback target", async () => {
    await expect(
      loadViteConfig({
        [diagnosticsModeEnv]: "localhost",
        [operatorTokenEnv]: "diagnostics-operator-token-for-test",
        [apiUrlEnv]: "https://api.example.test",
      }),
    ).rejects.toThrow("loopback CHALK_API_URL");
  });

  it("enables hosted development through an environment-owned same-origin gateway without a browser bearer", async () => {
    const config = await loadViteConfig({
      [diagnosticsModeEnv]: "hosted",
      [chalkEnvironmentEnv]: "development",
      [diagnosticsGatewayEnv]: "verified",
      [operatorTokenEnv]: "must-not-enter-hosted-browser-code",
    });

    expect(config.define?.__EPISODE_DIAGNOSTICS_ROUTE_ENABLED__).toBe("true");
    expect((config.server?.proxy as Record<string, unknown> | undefined)?.["/_internal/episode-diagnostics"]).toBeUndefined();
    expect(JSON.stringify(config.define)).not.toContain("must-not-enter-hosted-browser-code");
  });

  it.each([
    ["localhost", "production"],
    ["hosted", "production"],
    ["hosted", "localhost"],
  ])("refuses %s mode in %s", async (mode, environment) => {
    await expect(
      loadViteConfig({
        [diagnosticsModeEnv]: mode,
        [chalkEnvironmentEnv]: environment,
        [operatorTokenEnv]: "unused-operator-token",
      }),
    ).rejects.toThrow();
  });
});

async function loadViteConfig(environment: Record<string, string>): Promise<UserConfig> {
  vi.resetModules();
  vi.stubEnv(apiOriginEnv, environment[apiOriginEnv] ?? "");
  vi.stubEnv(webPortEnv, environment[webPortEnv] ?? "");
  vi.stubEnv(diagnosticsModeEnv, environment[diagnosticsModeEnv] ?? "");
  vi.stubEnv(chalkEnvironmentEnv, environment[chalkEnvironmentEnv] ?? "");
  vi.stubEnv(operatorTokenEnv, environment[operatorTokenEnv] ?? "");
  vi.stubEnv(diagnosticsGatewayEnv, environment[diagnosticsGatewayEnv] ?? "");
  vi.stubEnv(apiUrlEnv, environment[apiUrlEnv] ?? "");

  try {
    return (await import("./vite.config")).default;
  } finally {
    vi.unstubAllEnvs();
  }
}

function publicAPIProxy(config: UserConfig): ProxyOptions {
  const proxy = (config.server?.proxy as Record<string, string | ProxyOptions> | undefined)?.["/v1"];
  if (!proxy || typeof proxy === "string") throw new Error("Expected the /v1 public API proxy configuration");
  return proxy;
}

function diagnosticsProxy(config: UserConfig): ProxyOptions {
  const proxy = (config.server?.proxy as Record<string, string | ProxyOptions> | undefined)?.["/_internal/episode-diagnostics"];
  if (!proxy || typeof proxy === "string") throw new Error("Expected the Episode Diagnostics proxy configuration");
  return proxy;
}

function invokeProxyRequest(proxy: ProxyOptions): { on: ReturnType<typeof vi.fn>; setHeader: ReturnType<typeof vi.fn> } {
  const on = vi.fn();
  proxy.configure?.({ on } as never, proxy);
  const proxyRequestListener = on.mock.calls[0]?.[1] as (proxyRequest: { setHeader: (name: string, value: string) => void }) => void;
  const setHeader = vi.fn();
  proxyRequestListener({ setHeader });
  return { on, setHeader };
}
