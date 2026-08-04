const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "0.0.0.0"]);
const PUBLIC_WEB_HOSTS = ["chalkmeet.com", "chalk.q9labs.ai"] as const;
const DEFAULT_BROKER_URL = "https://chalkmeet.com/local-chalk";

export type MobileExpoExtra = {
  readonly brokerUrl: string;
  readonly buildProfile: string;
  readonly telemetryEnabled: boolean;
};

function isLocalUrl(url: string | undefined): boolean {
  if (!url) {
    return false;
  }

  try {
    return LOCAL_HOSTNAMES.has(new URL(url).hostname);
  } catch {
    return false;
  }
}

function isSupportedBrokerUrl(url: string | undefined): url is string {
  if (!url) {
    return false;
  }

  try {
    const parsed = new URL(url);
    return (parsed.protocol === "http:" || parsed.protocol === "https:") && !parsed.username && !parsed.password;
  } catch {
    return false;
  }
}

export function createExpoConfig(buildProfile = process.env.EAS_BUILD_PROFILE ?? process.env.CHALK_APP_VARIANT ?? "development") {
  const isProductionBuild = buildProfile === "production";
  const configuredBrokerUrl = process.env.EXPO_PUBLIC_CHALK_BROKER_URL?.trim();
  const brokerUrl = !isSupportedBrokerUrl(configuredBrokerUrl) || (isProductionBuild && isLocalUrl(configuredBrokerUrl)) ? DEFAULT_BROKER_URL : configuredBrokerUrl;
  const telemetryEnabled = process.env.EXPO_PUBLIC_CHALK_TELEMETRY_ENABLED?.trim().toLowerCase() === "true";

  const extra: MobileExpoExtra = {
    brokerUrl,
    buildProfile,
    telemetryEnabled,
  };

  return {
    expo: {
      name: "Chalk",
      slug: "chalk-mobile",
      scheme: "chalk",
      version: "2.0.0",
      orientation: "portrait",
      icon: "./assets/icon.png",
      userInterfaceStyle: "automatic",
      assetBundlePatterns: ["**/*"],
      plugins: ["expo-secure-store"],
      splash: {
        image: "./assets/splash-logo.png",
        resizeMode: "contain",
        backgroundColor: "#0b0c14",
      },
      ios: {
        jsEngine: "jsc",
        supportsTablet: true,
        bundleIdentifier: "ai.q9labs.chalk.mobile",
        buildNumber: "28",
        associatedDomains: PUBLIC_WEB_HOSTS.map((host) => `applinks:${host}`),
        entitlements: {
          "com.apple.security.application-groups": ["group.ai.q9labs.chalk.mobile"],
        },
        infoPlist: {
          ITSAppUsesNonExemptEncryption: false,
          NSCameraUsageDescription: "Chalk uses your camera so participants can see you in a Space.",
          NSMicrophoneUsageDescription: "Chalk uses your microphone so participants can hear you in a Space.",
          RTCAppScreenSharingExtension: "ai.q9labs.chalk.mobile.screenshare",
          UIBackgroundModes: ["audio", "voip"],
        },
      },
      android: {
        package: "ai.q9labs.chalk.mobile",
        versionCode: 28,
        adaptiveIcon: {
          foregroundImage: "./assets/icon.png",
          backgroundColor: "#0b0c14",
        },
        intentFilters: [
          {
            action: "VIEW",
            autoVerify: true,
            category: ["BROWSABLE", "DEFAULT"],
            data: [...PUBLIC_WEB_HOSTS.flatMap((host) => [{ scheme: "https", host, path: "/space" }])],
          },
        ],
        blockedPermissions: ["android.permission.SYSTEM_ALERT_WINDOW", "android.permission.READ_EXTERNAL_STORAGE", "android.permission.WRITE_EXTERNAL_STORAGE"],
        permissions: [
          "android.permission.ACCESS_NETWORK_STATE",
          "android.permission.BLUETOOTH",
          "android.permission.CAMERA",
          "android.permission.FOREGROUND_SERVICE",
          "android.permission.FOREGROUND_SERVICE_MEDIA_PROJECTION",
          "android.permission.FOREGROUND_SERVICE_MICROPHONE",
          "android.permission.INTERNET",
          "android.permission.MODIFY_AUDIO_SETTINGS",
          "android.permission.POST_NOTIFICATIONS",
          "android.permission.RECORD_AUDIO",
          "android.permission.VIBRATE",
          "android.permission.WAKE_LOCK",
        ],
      },
      extra,
    },
  };
}

export default createExpoConfig();
