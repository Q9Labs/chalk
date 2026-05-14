const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "0.0.0.0"]);
const PUBLIC_WEB_HOSTS = ["chalkmeet.com", "chalk.q9labs.ai"] as const;

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

export function createExpoConfig(buildProfile = process.env.EAS_BUILD_PROFILE ?? process.env.CHALK_APP_VARIANT ?? "development") {
  const isProductionBuild = buildProfile === "production";
  const configuredApiUrl = process.env.EXPO_PUBLIC_API_URL?.trim();
  const configuredWsUrl = process.env.EXPO_PUBLIC_WS_URL?.trim();
  const apiUrl = isProductionBuild && isLocalUrl(configuredApiUrl) ? "https://chalk-api.q9labs.ai" : configuredApiUrl || "https://chalk-api.q9labs.ai";
  const wsUrl = isProductionBuild && isLocalUrl(configuredWsUrl) ? "wss://chalk-ws.q9labs.ai/ws" : configuredWsUrl || "wss://chalk-ws.q9labs.ai/ws";

  return {
    expo: {
      name: "Chalk",
      slug: "chalk-mobile",
      scheme: "chalk",
      version: "1.0.1",
      orientation: "portrait",
      icon: "./assets/icon.png",
      userInterfaceStyle: "automatic",
      assetBundlePatterns: ["**/*"],
      plugins: [
        ...(isProductionBuild ? [] : ["expo-dev-client"]),
        "expo-secure-store",
        [
          "expo-audio",
          {
            enableBackgroundPlayback: false,
            enableBackgroundRecording: true,
            microphonePermission: "Chalk uses your microphone for background dictation.",
          },
        ],
        "expo-sqlite",
        "@cloudflare/realtimekit-react-native",
      ],
      splash: {
        image: "./assets/splash-logo.png",
        resizeMode: "contain",
        backgroundColor: "#0b0c14",
      },
      ios: {
        jsEngine: "jsc",
        supportsTablet: true,
        bundleIdentifier: "ai.q9labs.chalk.mobile",
        buildNumber: "19",
        entitlements: {
          "com.apple.security.application-groups": ["group.ai.q9labs.chalk.mobile"],
        },
        infoPlist: {
          ITSAppUsesNonExemptEncryption: false,
          NSCameraUsageDescription: "Chalk uses your camera so participants can see you during meetings.",
          NSMicrophoneUsageDescription: "Chalk uses your microphone for background dictation.",
          RTCAppScreenSharingExtension: "ai.q9labs.chalk.mobile.screenshare",
          UIBackgroundModes: ["audio", "voip"],
        },
      },
      android: {
        package: "ai.q9labs.chalk.mobile",
        versionCode: 19,
        adaptiveIcon: {
          foregroundImage: "./assets/icon.png",
          backgroundColor: "#0b0c14",
        },
        intentFilters: [
          {
            action: "VIEW",
            autoVerify: true,
            category: ["BROWSABLE", "DEFAULT"],
            data: [
              ...PUBLIC_WEB_HOSTS.flatMap((host) => [
                { scheme: "https", host, pathPrefix: "/j/" },
                { scheme: "https", host, pathPrefix: "/room/" },
              ]),
            ],
          },
        ],
        blockedPermissions: ["android.permission.SYSTEM_ALERT_WINDOW", "android.permission.READ_EXTERNAL_STORAGE", "android.permission.WRITE_EXTERNAL_STORAGE"],
        permissions: [
          "android.permission.ACCESS_NETWORK_STATE",
          "android.permission.BLUETOOTH",
          "android.permission.CAMERA",
          "android.permission.FOREGROUND_SERVICE",
          "android.permission.FOREGROUND_SERVICE_MICROPHONE",
          "android.permission.INTERNET",
          "android.permission.MANAGE_OWN_CALLS",
          "android.permission.MODIFY_AUDIO_SETTINGS",
          "android.permission.POST_NOTIFICATIONS",
          "android.permission.RECORD_AUDIO",
          "android.permission.VIBRATE",
          "android.permission.WAKE_LOCK",
        ],
      },
      extra: {
        apiUrl,
        wsUrl,
        buildProfile,
      },
    },
  };
}

export default createExpoConfig();
