const ANDROID_PLAY_STORE_URL =
  "https://play.google.com/store/apps/details?id=ai.q9labs.chalk.mobile";

export type MobileJoinPlatform = "android" | "ios";

export type MobileJoinIntent = {
  platform: MobileJoinPlatform;
  deepLinkUrl: string;
  storeUrl: string | null;
};

export function detectMobileJoinPlatform(
  userAgent: string | undefined | null,
): MobileJoinPlatform | null {
  if (!userAgent) {
    return null;
  }

  const normalized = userAgent.toLowerCase();
  if (normalized.includes("android")) {
    return "android";
  }

  const isAppleMobile = /(iphone|ipod|ipad)/.test(normalized);
  const isTouchMac =
    normalized.includes("macintosh") && normalized.includes("mobile");
  if (isAppleMobile || isTouchMac) {
    return "ios";
  }

  return null;
}

export function buildMobileJoinDeepLink(joinToken: string): string {
  return `chalk://j/${encodeURIComponent(joinToken)}`;
}

export function getMobileJoinStoreUrl(
  platform: MobileJoinPlatform,
  iosStoreUrl?: string | null,
): string | null {
  if (platform === "android") {
    return ANDROID_PLAY_STORE_URL;
  }

  const normalized = iosStoreUrl?.trim();
  return normalized && normalized.length > 0 ? normalized : null;
}

export function buildMobileJoinIntent({
  iosStoreUrl,
  joinToken,
  userAgent,
}: {
  iosStoreUrl?: string | null;
  joinToken: string;
  userAgent: string | undefined | null;
}): MobileJoinIntent | null {
  const platform = detectMobileJoinPlatform(userAgent);
  if (!platform) {
    return null;
  }

  return {
    platform,
    deepLinkUrl: buildMobileJoinDeepLink(joinToken),
    storeUrl: getMobileJoinStoreUrl(platform, iosStoreUrl),
  };
}
