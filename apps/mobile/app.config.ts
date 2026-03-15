export function createExpoConfig(buildProfile = process.env.EAS_BUILD_PROFILE ?? process.env.CHALK_APP_VARIANT ?? "development") {
  const isProductionBuild = buildProfile === "production";
  const apiUrl = process.env.EXPO_PUBLIC_API_URL?.trim() || "https://chalk-api.q9labs.ai";
  const wsUrl = process.env.EXPO_PUBLIC_WS_URL?.trim() || "wss://chalk-ws.q9labs.ai/ws";

  return {
    expo: {
      name: "Chalk",
      slug: "chalk-mobile",
      scheme: "chalk",
      version: "0.0.4",
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
        buildNumber: "4",
        infoPlist: {
          ITSAppUsesNonExemptEncryption: false,
          NSCameraUsageDescription: "Chalk uses your camera so participants can see you during meetings.",
          NSMicrophoneUsageDescription: "Chalk uses your microphone so participants can hear you during meetings.",
          UIBackgroundModes: ["audio"],
        },
      },
      android: {
        package: "ai.q9labs.chalk.mobile",
        versionCode: 4,
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
          "android.permission.FOREGROUND_SERVICE_MEDIA_PROJECTION",
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
      },
    },
  };
}

export default createExpoConfig();
