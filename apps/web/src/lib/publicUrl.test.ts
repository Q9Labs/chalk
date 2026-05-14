import { afterEach, describe, expect, it, vi } from "vitest";
import { getPublicAppOrigin, getPublicAppUrl, resolvePublicAppOrigin } from "./publicUrl";

const originalWindow = globalThis.window;

function installBrowserEnv(rawUrl: string) {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { location: new URL(rawUrl) },
    writable: true,
  });
}

function restoreBrowserEnv() {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: originalWindow,
    writable: true,
  });
}

describe("publicUrl helpers", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    restoreBrowserEnv();
  });

  it("defaults hosted origins to the canonical chalkmeet domain", () => {
    expect(resolvePublicAppOrigin(undefined, "https://chalk.q9labs.ai")).toBe("https://chalkmeet.com");
    expect(resolvePublicAppOrigin(undefined, "https://chalkmeet.com")).toBe("https://chalkmeet.com");
  });

  it("keeps localhost origins local", () => {
    expect(resolvePublicAppOrigin("https://chalkmeet.com", "http://localhost:3070")).toBe("http://localhost:3070");
  });

  it("uses the active browser origin on localhost", () => {
    installBrowserEnv("http://localhost:3070/dashboard");

    expect(getPublicAppOrigin()).toBe("http://localhost:3070");
    expect(getPublicAppUrl("/j/join-token-123")).toBe("http://localhost:3070/j/join-token-123");
  });
});
