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
      { scheme: "https", host: "chalk.q9labs.ai", pathPrefix: "/j/" },
      { scheme: "https", host: "chalk.q9labs.ai", pathPrefix: "/room/" },
    ]);
    expect(config.expo.extra.wsUrl).toBeDefined();
  });
});
