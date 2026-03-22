const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "0.0.0.0"]);

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
      owner: "hhushhas14",
      scheme: "chalk",
      version: "0.0.10",
      orientation: "portrait",
      icon: "./assets/icon.png",
      userInterfaceStyle: "automatic",
      assetBundlePatterns: ["**/*"],
      plugins: [...(isProductionBuild ? [] : ["expo-dev-client"]), "expo-secure-store", "@cloudflare/realtimekit-react-native"],
      splash: {
        image: "./assets/icon.png",
        resizeMode: "contain",
        backgroundColor: "#f4f1eb",
      },
      ios: {
        supportsTablet: true,
        bundleIdentifier: "ai.q9labs.chalk.mobile",
        buildNumber: "10",
        infoPlist: {
          ITSAppUsesNonExemptEncryption: false,
          NSCameraUsageDescription: "Chalk uses your camera so participants can see you during meetings.",
          NSMicrophoneUsageDescription: "Chalk uses your microphone so participants can hear you during meetings.",
          UIBackgroundModes: ["audio"],
        },
      },
      android: {
        package: "ai.q9labs.chalk.mobile",
        versionCode: 10,
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
              { scheme: "https", host: "chalk.q9labs.ai", pathPrefix: "/j/" },
              { scheme: "https", host: "chalk.q9labs.ai", pathPrefix: "/room/" },
            ],
          },
        ],
        blockedPermissions: ["android.permission.SYSTEM_ALERT_WINDOW", "android.permission.READ_EXTERNAL_STORAGE", "android.permission.WRITE_EXTERNAL_STORAGE"],
        permissions: [
          "android.permission.ACCESS_NETWORK_STATE",
          "android.permission.BLUETOOTH",
          "android.permission.CAMERA",
          "android.permission.FOREGROUND_SERVICE",
          "android.permission.INTERNET",
          "android.permission.MODIFY_AUDIO_SETTINGS",
          "android.permission.RECORD_AUDIO",
          "android.permission.VIBRATE",
          "android.permission.WAKE_LOCK",
        ],
      },
      extra: {
        apiUrl,
        wsUrl,
        buildProfile,
        eas: {
          projectId: "699bd2b8-fe9b-4740-9de4-b23741ce9d6b",
        },
      },
    },
  };
}

export default createExpoConfig();
