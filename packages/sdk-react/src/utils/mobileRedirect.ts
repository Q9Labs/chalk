import { extractJoinTokenFromInviteLink } from "@q9labs/chalk-core";

const PROD_PUBLIC_APP_URL = "https://chalkmeet.com";
const ANDROID_PLAY_STORE_URL =
  "https://play.google.com/store/apps/details?id=ai.q9labs.chalk.mobile";
const IOS_APP_STORE_URL = "https://apps.apple.com/app/id6760978704";
const IOS_BUNDLE_DEEP_LINK_SCHEME = "ai.q9labs.chalk.mobile";

export type MobileJoinPlatform = "android" | "ios";

export type MobileJoinIntent = {
  platform: MobileJoinPlatform;
  deepLinkUrl: string;
  fallbackDeepLinkUrl: string | null;
  storeUrl: string | null;
};

function isLocalHost(hostname: string | undefined) {
  if (!hostname) return false;
  const normalized = hostname.trim().toLowerCase();
  return (
    normalized === "localhost" ||
    normalized === "127.0.0.1" ||
    normalized === "::1" ||
    normalized === "[::1]" ||
    normalized.endsWith(".localhost")
  );
}

export function resolvePublicAppOrigin(
  configuredPublicAppUrl?: string,
  currentOrigin?: string,
) {
  if (currentOrigin) {
    try {
      const current = new URL(currentOrigin);
      if (isLocalHost(current.hostname)) {
        return current.origin;
      }
    } catch {
      // Fall through to configured/default origin.
    }
  }

  const normalizedConfigured = configuredPublicAppUrl?.trim();
  return normalizedConfigured || PROD_PUBLIC_APP_URL;
}

export function buildPublicJoinLink(
  joinToken: string,
  configuredPublicAppUrl?: string,
  currentOrigin?: string,
) {
  const origin = resolvePublicAppOrigin(configuredPublicAppUrl, currentOrigin);
  return new URL(`/j/${encodeURIComponent(joinToken)}`, origin).toString();
}

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

export function buildMobileJoinDeepLink(
  joinToken: string,
  scheme = "chalk",
): string {
  return `${scheme}://j/${encodeURIComponent(joinToken)}`;
}

export function getMobileJoinStoreUrl(
  platform: MobileJoinPlatform,
  iosStoreUrl?: string | null,
): string | null {
  if (platform === "android") {
    return ANDROID_PLAY_STORE_URL;
  }

  const normalized = iosStoreUrl?.trim();
  return normalized && normalized.length > 0 ? normalized : IOS_APP_STORE_URL;
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
    fallbackDeepLinkUrl:
      platform === "ios"
        ? buildMobileJoinDeepLink(joinToken, IOS_BUNDLE_DEEP_LINK_SCHEME)
        : null,
    storeUrl: getMobileJoinStoreUrl(platform, iosStoreUrl),
  };
}

export function resolveJoinTokenFromJoinTarget({
  inviteLink,
  joinToken,
}: {
  inviteLink?: string;
  joinToken?: string;
}) {
  const normalizedJoinToken = joinToken?.trim();
  if (normalizedJoinToken) {
    return normalizedJoinToken;
  }

  const normalizedInviteLink = inviteLink?.trim();
  if (!normalizedInviteLink) {
    return null;
  }

  return extractJoinTokenFromInviteLink(normalizedInviteLink);
}
