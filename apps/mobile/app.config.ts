const PUBLIC_WEB_HOSTS: readonly string[] = ["chalkmeet.com", "chalk.q9labs.ai"];
// The call's dark canvas, so the launch screen hands over to the first frame without a flash.
const SPLASH_BACKGROUND = "#0B0C0E";
// The icon plate from `src/brand/mark.ts` (`ICON_COLORS.plate`); Expo config files cannot import app source.
const ICON_PLATE = "#16181c";
// The call's typeface, embedded at build time so the first frame already uses it.
const FIGTREE_WEIGHTS = ["Regular", "Medium", "SemiBold", "Bold"] as const;

export type MobileExpoExtra = {
  readonly buildProfile: string;
  readonly eas: {
    readonly projectId: string;
  };
};

export function createExpoConfig(buildProfile = process.env.EAS_BUILD_PROFILE ?? process.env.CHALK_APP_VARIANT ?? "development") {
  const extra: MobileExpoExtra = { buildProfile, eas: { projectId: "13257936-7f15-4278-8240-33dc4e01297d" } };

  return {
    expo: {
      name: "Chalk",
      owner: "q9labs",
      slug: "chalk-mobile",
      scheme: "chalk",
      version: "3.0.0",
      // The call turns to landscape; Home stays usable in either.
      orientation: "default",
      icon: "./assets/icon.png",
      userInterfaceStyle: "automatic",
      assetBundlePatterns: ["**/*"],
      experiments: { tsconfigPaths: false },
      plugins: [
        "expo-secure-store",
        ["expo-font", { fonts: FIGTREE_WEIGHTS.map((weight) => `./assets/fonts/Figtree-${weight}.ttf`) }],
        // A8: the mark alone on the call background. `pnpm run brand-assets` renders it and the icons from `src/brand/mark.ts`.
        ["expo-splash-screen", { image: "./assets/splash-mark.png", imageWidth: 112, resizeMode: "contain", backgroundColor: SPLASH_BACKGROUND }],
        "./plugins/with-worklets-legacy-output.js",
      ],
      ios: {
        jsEngine: "jsc",
        supportsTablet: true,
        bundleIdentifier: "ai.q9labs.chalk.mobile",
        buildNumber: "31",
        associatedDomains: PUBLIC_WEB_HOSTS.map((host) => `applinks:${host}`),
        entitlements: { "com.apple.security.application-groups": ["group.ai.q9labs.chalk.mobile"] },
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
        versionCode: 33,
        adaptiveIcon: { foregroundImage: "./assets/adaptive-icon.png", monochromeImage: "./assets/adaptive-icon-monochrome.png", backgroundColor: ICON_PLATE },
        intentFilters: [
          {
            action: "VIEW",
            autoVerify: true,
            category: ["BROWSABLE", "DEFAULT"],
            data: [...PUBLIC_WEB_HOSTS.flatMap((host) => [{ scheme: "https", host, pathPrefix: "/space" }])],
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
