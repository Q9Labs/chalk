import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createExpoConfig } from "./app.config";

const iosInfoPlist = readFileSync(new URL("./ios/Chalk/Info.plist", import.meta.url), "utf8");
const iosProject = readFileSync(new URL("./ios/Chalk.xcodeproj/project.pbxproj", import.meta.url), "utf8");

describe("createExpoConfig", () => {
  it("keeps development builds on the same native module graph", () => {
    const config = createExpoConfig("development");

    expect(config.expo.plugins).toEqual(["expo-secure-store"]);
    expect(config.expo.experiments.tsconfigPaths).toBe(false);
    expect(config.expo.android.blockedPermissions).toContain("android.permission.SYSTEM_ALERT_WINDOW");
    expect(config.expo.extra.telemetryEnabled).toBe(false);
  });

  it("only enables telemetry when the deployment opts in explicitly", () => {
    const originalTelemetry = process.env.EXPO_PUBLIC_CHALK_TELEMETRY_ENABLED;

    delete process.env.EXPO_PUBLIC_CHALK_TELEMETRY_ENABLED;
    expect(createExpoConfig("development").expo.extra.telemetryEnabled).toBe(false);

    process.env.EXPO_PUBLIC_CHALK_TELEMETRY_ENABLED = "false";
    expect(createExpoConfig("development").expo.extra.telemetryEnabled).toBe(false);

    process.env.EXPO_PUBLIC_CHALK_TELEMETRY_ENABLED = "true";
    expect(createExpoConfig("development").expo.extra.telemetryEnabled).toBe(true);

    if (originalTelemetry === undefined) delete process.env.EXPO_PUBLIC_CHALK_TELEMETRY_ENABLED;
    else process.env.EXPO_PUBLIC_CHALK_TELEMETRY_ENABLED = originalTelemetry;
  });

  it("configures production builds without development-only native modules", () => {
    const config = createExpoConfig("production");

    expect(config.expo.plugins).toEqual(["expo-secure-store"]);
    expect(config.expo.version).toBe("2.0.0");
    expect(config.expo.ios.buildNumber).toBe("28");
    expect(config.expo.android.versionCode).toBe(28);
    expect(config.expo.ios.infoPlist.ITSAppUsesNonExemptEncryption).toBe(false);
    expect(config.expo.ios.infoPlist.RTCAppScreenSharingExtension).toBe("ai.q9labs.chalk.mobile.screenshare");
    expect(config.expo.ios.entitlements?.["com.apple.security.application-groups"]).toEqual(["group.ai.q9labs.chalk.mobile"]);
    expect(config.expo.ios.associatedDomains).toEqual(["applinks:chalkmeet.com", "applinks:chalk.q9labs.ai"]);
    expect(config.expo.scheme).toBe("chalk");
    expect(config.expo.splash.image).toBe("./assets/splash-logo.png");
    expect(config.expo.splash.backgroundColor).toBe("#F7F6F2");
    expect(config.expo.android.adaptiveIcon.backgroundColor).toBe("#030303");
    expect(config.expo.android.adaptiveIcon.foregroundImage).toBe("./assets/adaptive-icon.png");
    expect(config.expo.ios.infoPlist.NSCameraUsageDescription).toContain("in a Space");
    expect(config.expo.android.intentFilters?.[0]?.data).toEqual([
      { scheme: "https", host: "chalkmeet.com", path: "/space" },
      { scheme: "https", host: "chalk.q9labs.ai", path: "/space" },
    ]);
    expect(config.expo.extra.brokerUrl).toBe("https://chalkmeet.com/local-chalk");
  });

  it("keeps archive inputs aligned with the Expo release version and build", () => {
    expect(plistValue(iosInfoPlist, "CFBundleShortVersionString")).toBe("2.0.0");
    expect(plistValue(iosInfoPlist, "CFBundleVersion")).toBe("28");
    expect(iosProject).not.toContain("MARKETING_VERSION = 1.0.1;");
    expect(iosProject).not.toContain("CURRENT_PROJECT_VERSION = 19;");
    expect(iosProject.match(/MARKETING_VERSION = 2\.0\.0;/gu)).toHaveLength(4);
    expect(iosProject.match(/CURRENT_PROJECT_VERSION = 28;/gu)).toHaveLength(4);
  });

  it("forces the production broker when a local URL leaks into a production build", () => {
    const originalBrokerUrl = process.env.EXPO_PUBLIC_CHALK_BROKER_URL;

    process.env.EXPO_PUBLIC_CHALK_BROKER_URL = "http://localhost:8787/local-chalk";

    const config = createExpoConfig("production");

    expect(config.expo.extra.brokerUrl).toBe("https://chalkmeet.com/local-chalk");

    if (originalBrokerUrl === undefined) delete process.env.EXPO_PUBLIC_CHALK_BROKER_URL;
    else process.env.EXPO_PUBLIC_CHALK_BROKER_URL = originalBrokerUrl;
  });

  it("falls back to the production broker when the configured URL is invalid", () => {
    const originalBrokerUrl = process.env.EXPO_PUBLIC_CHALK_BROKER_URL;

    process.env.EXPO_PUBLIC_CHALK_BROKER_URL = "not-a-url";

    expect(createExpoConfig("development").expo.extra.brokerUrl).toBe("https://chalkmeet.com/local-chalk");

    if (originalBrokerUrl === undefined) delete process.env.EXPO_PUBLIC_CHALK_BROKER_URL;
    else process.env.EXPO_PUBLIC_CHALK_BROKER_URL = originalBrokerUrl;
  });

  it("passes the local broker URL into development builds", () => {
    const originalBrokerUrl = process.env.EXPO_PUBLIC_CHALK_BROKER_URL;

    process.env.EXPO_PUBLIC_CHALK_BROKER_URL = "http://127.0.0.1:8787/local-chalk";

    const config = createExpoConfig("development");

    expect(config.expo.extra.brokerUrl).toBe("http://127.0.0.1:8787/local-chalk");

    if (originalBrokerUrl === undefined) {
      delete process.env.EXPO_PUBLIC_CHALK_BROKER_URL;
    } else {
      process.env.EXPO_PUBLIC_CHALK_BROKER_URL = originalBrokerUrl;
    }
  });
});

function plistValue(plist: string, key: string): string {
  const match = plist.match(new RegExp(`<key>${key}</key>\\s*<string>([^<]+)</string>`, "u"));
  if (!match?.[1]) throw new Error(`Missing ${key} in iOS Info.plist`);
  return match[1];
}
