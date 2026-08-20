import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createExpoConfig } from "./app.config";

const iosInfoPlist = readFileSync(new URL("./ios/Chalk/Info.plist", import.meta.url), "utf8");
const iosProject = readFileSync(new URL("./ios/Chalk.xcodeproj/project.pbxproj", import.meta.url), "utf8");
const androidManifest = readFileSync(new URL("./android/app/src/main/AndroidManifest.xml", import.meta.url), "utf8");
const androidStrings = readFileSync(new URL("./android/app/src/main/res/values/strings.xml", import.meta.url), "utf8");

describe("createExpoConfig", () => {
  it("keeps the native module graph and public build metadata stable", () => {
    const config = createExpoConfig("development");

    expect(config.expo.plugins).toEqual([
      "expo-secure-store",
      ["@cloudflare/realtimekit-react-native", { microphonePermission: "Chalk uses your microphone so participants can hear you in a Space.", cameraPermission: "Chalk uses your camera so participants can see you in a Space.", libraryPermission: false }],
    ]);
    expect(config.expo.experiments.tsconfigPaths).toBe(false);
    expect(config.expo.extra).toEqual({ buildProfile: "development" });
    expect(config.expo.android.blockedPermissions).toContain("android.permission.SYSTEM_ALERT_WINDOW");
  });

  it("registers the canonical Space path with both public hosts", () => {
    const config = createExpoConfig("production");

    expect(config.expo.ios.associatedDomains).toEqual(["applinks:chalkmeet.com", "applinks:chalk.q9labs.ai"]);
    expect(config.expo.android.intentFilters?.[0]?.data).toEqual([
      { scheme: "https", host: "chalkmeet.com", pathPrefix: "/space" },
      { scheme: "https", host: "chalk.q9labs.ai", pathPrefix: "/space" },
    ]);
    expect(androidManifest).toContain('android:host="chalkmeet.com" android:pathPrefix="/space"');
    expect(androidManifest).toContain('android:host="chalk.q9labs.ai" android:pathPrefix="/space"');
    expect(androidManifest).not.toContain('android:path="/space"');
  });

  it("keeps the RealtimeKit foreground service and blob authority configured", () => {
    expect(androidManifest).toContain("com.cloudflare.realtimekit.ForegroundService");
    expect(androidStrings).toContain("blob_provider_authority");
  });

  it("keeps archive inputs aligned with the Expo release version and build", () => {
    expect(plistValue(iosInfoPlist, "CFBundleShortVersionString")).toBe("2.0.0");
    expect(plistValue(iosInfoPlist, "CFBundleVersion")).toBe("28");
    expect(iosProject).not.toContain("MARKETING_VERSION = 1.0.1;");
    expect(iosProject).not.toContain("CURRENT_PROJECT_VERSION = 19;");
    expect(iosProject.match(/MARKETING_VERSION = 2\.0\.0;/gu)).toHaveLength(4);
    expect(iosProject.match(/CURRENT_PROJECT_VERSION = 28;/gu)).toHaveLength(4);
  });
});

function plistValue(plist: string, key: string): string {
  const match = plist.match(new RegExp(`<key>${key}</key>\\s*<string>([^<]+)</string>`, "u"));
  if (!match?.[1]) throw new Error(`Missing ${key} in iOS Info.plist`);
  return match[1];
}
