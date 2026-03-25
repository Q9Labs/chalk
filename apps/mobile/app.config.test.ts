import { describe, expect, it } from "bun:test";
import { createExpoConfig } from "./app.config";

describe("createExpoConfig", () => {
  it("keeps dev client enabled outside production", () => {
    const config = createExpoConfig("development");

    expect(config.expo.plugins).toContain("expo-dev-client");
    expect(config.expo.android.blockedPermissions).toContain("android.permission.SYSTEM_ALERT_WINDOW");
  });

  it("drops dev client in production builds", () => {
    const config = createExpoConfig("production");

    expect(config.expo.plugins).not.toContain("expo-dev-client");
    expect(config.expo.ios.infoPlist.ITSAppUsesNonExemptEncryption).toBe(false);
    expect(config.expo.android.adaptiveIcon.backgroundColor).toBe("#0b0c14");
    expect(config.expo.android.intentFilters?.[0]?.data).toEqual([
      { scheme: "https", host: "chalkmeet.com", pathPrefix: "/j/" },
      { scheme: "https", host: "chalkmeet.com", pathPrefix: "/room/" },
      { scheme: "https", host: "chalk.q9labs.ai", pathPrefix: "/j/" },
      { scheme: "https", host: "chalk.q9labs.ai", pathPrefix: "/room/" },
    ]);
    expect(config.expo.extra.wsUrl).toBeDefined();
  });

  it("forces production API and WS URLs when local env values leak into production builds", () => {
    const originalApiUrl = process.env.EXPO_PUBLIC_API_URL;
    const originalWsUrl = process.env.EXPO_PUBLIC_WS_URL;

    process.env.EXPO_PUBLIC_API_URL = "http://localhost:8080";
    process.env.EXPO_PUBLIC_WS_URL = "ws://localhost:8080/ws";

    const config = createExpoConfig("production");

    expect(config.expo.extra.apiUrl).toBe("https://chalk-api.q9labs.ai");
    expect(config.expo.extra.wsUrl).toBe("wss://chalk-ws.q9labs.ai/ws");

    process.env.EXPO_PUBLIC_API_URL = originalApiUrl;
    process.env.EXPO_PUBLIC_WS_URL = originalWsUrl;
  });
});
