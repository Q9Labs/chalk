import { describe, expect, it, vi } from "vitest";
import type { ProxyOptions, UserConfig } from "vite";

const brokerOriginEnv = "CHALK_DEV_BROKER_ORIGIN";
const brokerPortEnv = "CHALK_DEV_BROKER_PORT";

describe("local broker Vite proxy", () => {
  it.each([
    [{}, "http://127.0.0.1:3071"],
    [{ [brokerPortEnv]: "4101" }, "http://127.0.0.1:4101"],
    [{ [brokerOriginEnv]: "https://broker.example.test" }, "https://broker.example.test"],
    [{ [brokerOriginEnv]: "https://broker.example.test", [brokerPortEnv]: "4101" }, "https://broker.example.test"],
  ])("uses the configured broker target %#", async (environment, target) => {
    const config = await loadViteConfig(environment);
    const proxy = localProxy(config);

    expect(proxy.target).toBe(target);
    expect(proxy.changeOrigin).toBe(true);
  });

  it("sets the browser origin on local broker requests", async () => {
    const config = await loadViteConfig({});
    const proxy = localProxy(config);
    const on = vi.fn();

    proxy.configure?.({ on } as never, proxy);

    expect(on).toHaveBeenCalledWith("proxyReq", expect.any(Function));
    const proxyRequestListener = on.mock.calls[0]?.[1] as (proxyRequest: { setHeader: (name: string, value: string) => void }) => void;
    const setHeader = vi.fn();

    proxyRequestListener({ setHeader });

    expect(setHeader).toHaveBeenCalledWith("origin", "http://127.0.0.1:3070");
  });
});

async function loadViteConfig(environment: Record<string, string>): Promise<UserConfig> {
  vi.resetModules();
  vi.stubEnv(brokerOriginEnv, environment[brokerOriginEnv] ?? "");
  vi.stubEnv(brokerPortEnv, environment[brokerPortEnv] ?? "");

  try {
    return (await import("./vite.config")).default;
  } finally {
    vi.unstubAllEnvs();
  }
}

function localProxy(config: UserConfig): ProxyOptions {
  const proxy = (config.server?.proxy as Record<string, string | ProxyOptions> | undefined)?.["/local-chalk"];
  if (!proxy || typeof proxy === "string") throw new Error("Expected the /local-chalk proxy configuration");
  return proxy;
}
