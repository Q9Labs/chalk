import { describe, expect, it } from "vitest";
import {
  buildMobileJoinDeepLink,
  buildMobileJoinIntent,
  detectMobileJoinPlatform,
  getMobileJoinStoreUrl,
} from "./mobileJoinRedirect";

describe("mobileJoinRedirect", () => {
  it("detects android and ios mobile user agents", () => {
    expect(
      detectMobileJoinPlatform(
        "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/122.0 Mobile Safari/537.36",
      ),
    ).toBe("android");
    expect(
      detectMobileJoinPlatform(
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 Version/17.4 Mobile/15E148 Safari/604.1",
      ),
    ).toBe("ios");
    expect(
      detectMobileJoinPlatform(
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/17.4 Mobile/15E148 Safari/604.1",
      ),
    ).toBe("ios");
    expect(
      detectMobileJoinPlatform(
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/123.0 Safari/537.36",
      ),
    ).toBeNull();
  });

  it("builds the native deep link into the mobile lobby flow", () => {
    expect(buildMobileJoinDeepLink("join-token-123")).toBe(
      "chalk://j/join-token-123",
    );
    expect(buildMobileJoinDeepLink("join token/123")).toBe(
      "chalk://j/join%20token%2F123",
    );
  });

  it("returns platform-specific store urls", () => {
    expect(getMobileJoinStoreUrl("android")).toBe(
      "https://play.google.com/store/apps/details?id=ai.q9labs.chalk.mobile",
    );
    expect(
      getMobileJoinStoreUrl("ios", "https://apps.apple.com/app/id123"),
    ).toBe("https://apps.apple.com/app/id123");
    expect(getMobileJoinStoreUrl("ios")).toBeNull();
  });

  it("builds a mobile open-in-app intent for mobile browsers only", () => {
    expect(
      buildMobileJoinIntent({
        joinToken: "join-token-123",
        userAgent: "Mozilla/5.0 (Linux; Android 14; Pixel 8)",
      }),
    ).toEqual({
      platform: "android",
      deepLinkUrl: "chalk://j/join-token-123",
      storeUrl:
        "https://play.google.com/store/apps/details?id=ai.q9labs.chalk.mobile",
    });

    expect(
      buildMobileJoinIntent({
        joinToken: "join-token-123",
        userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X)",
        iosStoreUrl: "https://apps.apple.com/app/id123",
      }),
    ).toEqual({
      platform: "ios",
      deepLinkUrl: "chalk://j/join-token-123",
      storeUrl: "https://apps.apple.com/app/id123",
    });

    expect(
      buildMobileJoinIntent({
        joinToken: "join-token-123",
        userAgent: "Mozilla/5.0 (X11; Linux x86_64)",
      }),
    ).toBeNull();
  });
});
