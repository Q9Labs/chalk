import { describe, expect, it } from "vitest";
import { createExpoConfig } from "./app.config";

describe("createExpoConfig", () => {
  it("keeps development builds on the same native module graph", () => {
    const config = createExpoConfig("development");

    expect(config.expo.plugins).toEqual(["expo-secure-store"]);
    expect(config.expo.android.blockedPermissions).toContain("android.permission.SYSTEM_ALERT_WINDOW");
  });

  it("configures production builds without development-only native modules", () => {
    const config = createExpoConfig("production");

    expect(config.expo.plugins).toEqual(["expo-secure-store"]);
    expect(config.expo.version).toBe("2.0.0");
    expect(config.expo.ios.buildNumber).toBe("23");
    expect(config.expo.android.versionCode).toBe(23);
    expect(config.expo.ios.infoPlist.ITSAppUsesNonExemptEncryption).toBe(false);
    expect(config.expo.ios.infoPlist.RTCAppScreenSharingExtension).toBe("ai.q9labs.chalk.mobile.screenshare");
    expect(config.expo.ios.entitlements?.["com.apple.security.application-groups"]).toEqual(["group.ai.q9labs.chalk.mobile"]);
    expect(config.expo.ios.associatedDomains).toEqual(["applinks:chalkmeet.com", "applinks:chalk.q9labs.ai"]);
    expect(config.expo.scheme).toBe("chalk");
    expect(config.expo.splash.image).toBe("./assets/splash-logo.png");
    expect(config.expo.splash.backgroundColor).toBe("#0b0c14");
    expect(config.expo.android.adaptiveIcon.backgroundColor).toBe("#0b0c14");
    expect(config.expo.android.intentFilters?.[0]?.data).toEqual([
      { scheme: "https", host: "chalkmeet.com", pathPrefix: "/j/" },
      { scheme: "https", host: "chalkmeet.com", path: "/room" },
      { scheme: "https", host: "chalkmeet.com", pathPrefix: "/room/" },
      { scheme: "https", host: "chalk.q9labs.ai", pathPrefix: "/j/" },
      { scheme: "https", host: "chalk.q9labs.ai", path: "/room" },
      { scheme: "https", host: "chalk.q9labs.ai", pathPrefix: "/room/" },
    ]);
    expect(config.expo.extra.brokerUrl).toBe("https://chalkmeet.com/local-chalk");
  });

  it("forces the production broker when a local URL leaks into a production build", () => {
    const originalBrokerUrl = process.env.EXPO_PUBLIC_CHALK_BROKER_URL;

    process.env.EXPO_PUBLIC_CHALK_BROKER_URL = "http://localhost:8787/local-chalk";

    const config = createExpoConfig("production");

    expect(config.expo.extra.brokerUrl).toBe("https://chalkmeet.com/local-chalk");

    process.env.EXPO_PUBLIC_CHALK_BROKER_URL = originalBrokerUrl;
  });
});
