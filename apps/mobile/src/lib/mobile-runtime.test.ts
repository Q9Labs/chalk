import { describe, expect, it } from "vitest";
import { canUseLocalHostBootstrap, createStorageScopeId, getMetroHostFromScriptUrl, isConfiguredLocalApiUrl, isDeviceLocalUrl, resolveAppRuntimeUrl, resolveDeviceLocalUrl } from "./mobile-runtime";

describe("mobile runtime helpers", () => {
  it("derives a stable scoped token namespace", () => {
    expect(createStorageScopeId("https://chalk-api.q9labs.ai", "ck_live_test")).toBe(createStorageScopeId("https://chalk-api.q9labs.ai", "ck_live_test"));
    expect(createStorageScopeId("https://chalk-api.q9labs.ai", "ck_live_test")).not.toBe(createStorageScopeId("https://chalk-api.q9labs.ai", "ck_other"));
  });

  it("extracts the Metro host from a device script URL", () => {
    expect(getMetroHostFromScriptUrl("http://192.168.18.245:8081/index.bundle?platform=android")).toBe("192.168.18.245");
    expect(getMetroHostFromScriptUrl(null)).toBeNull();
  });

  it("rewrites localhost URLs to the Metro host for device builds", () => {
    const scriptUrl = "http://192.168.18.245:8081/index.bundle?platform=android";

    expect(resolveDeviceLocalUrl("http://localhost:8080", scriptUrl)).toBe("http://192.168.18.245:8080");
    expect(resolveDeviceLocalUrl("ws://127.0.0.1:8080/ws", scriptUrl)).toBe("ws://192.168.18.245:8080/ws");
    expect(resolveDeviceLocalUrl("https://chalk-api.q9labs.ai", scriptUrl)).toBe("https://chalk-api.q9labs.ai");
  });

  it("falls back to production URLs when release builds still carry localhost env values", () => {
    expect(resolveDeviceLocalUrl("http://localhost:8080", null, "https://chalk-api.q9labs.ai")).toBe("https://chalk-api.q9labs.ai");
    expect(resolveDeviceLocalUrl("ws://127.0.0.1:8080/ws", undefined, "wss://chalk-ws.q9labs.ai/ws")).toBe("wss://chalk-ws.q9labs.ai/ws");
  });

  it("preserves localhost URLs when the dev bundle is also served from localhost", () => {
    const scriptUrl = "http://localhost:8081/index.bundle?platform=ios";

    expect(resolveDeviceLocalUrl("http://localhost:8080", scriptUrl, "https://chalk-api.q9labs.ai")).toBe("http://localhost:8080");
    expect(resolveDeviceLocalUrl("ws://127.0.0.1:8080/ws", scriptUrl, "wss://chalk-ws.q9labs.ai/ws")).toBe("ws://127.0.0.1:8080/ws");
  });

  it("hard-forces production URLs when release builds disallow device-local hosts", () => {
    expect(
      resolveAppRuntimeUrl({
        configuredUrl: "http://localhost:8080",
        scriptUrl: "file:///android_asset/index.android.bundle",
        fallbackUrl: "https://chalk-api.q9labs.ai",
        allowDeviceLocal: false,
      }),
    ).toBe("https://chalk-api.q9labs.ai");

    expect(
      resolveAppRuntimeUrl({
        configuredUrl: "ws://localhost:8080/ws",
        scriptUrl: "file:///android_asset/index.android.bundle",
        fallbackUrl: "wss://chalk-ws.q9labs.ai/ws",
        allowDeviceLocal: false,
      }),
    ).toBe("wss://chalk-ws.q9labs.ai/ws");
  });

  it("detects local device URLs", () => {
    expect(isDeviceLocalUrl("http://localhost:8080")).toBe(true);
    expect(isDeviceLocalUrl("ws://127.0.0.1:8080/ws")).toBe(true);
    expect(isDeviceLocalUrl("https://chalk-api.q9labs.ai")).toBe(false);
  });

  it("detects configured local api urls even outside dev mode", () => {
    expect(isConfiguredLocalApiUrl("http://localhost:8080")).toBe(true);
    expect(isConfiguredLocalApiUrl(" ws://127.0.0.1:8080/ws ")).toBe(true);
    expect(isConfiguredLocalApiUrl("https://chalk-api.q9labs.ai")).toBe(false);
    expect(isConfiguredLocalApiUrl(undefined)).toBe(false);
  });

  it("only allows host bootstrap for resolved local runtime urls", () => {
    expect(canUseLocalHostBootstrap("http://localhost:8080", true)).toBe(true);
    expect(canUseLocalHostBootstrap("https://chalk-api.q9labs.ai", true)).toBe(false);
    expect(canUseLocalHostBootstrap("http://localhost:8080", false)).toBe(false);
  });
});
