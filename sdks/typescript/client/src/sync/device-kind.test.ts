import { describe, expect, it } from "vitest";
import { detectWebDeviceKind, type ParticipantDeviceKind, type WebDeviceEnvironment } from "./device-kind";
import { syncEntryUrl } from "./entry-url";

// Strings copied from the browsers they name.
const IPHONE_SAFARI = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
const IPHONE_CHROME = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/126.0.6478.35 Mobile/15E148 Safari/604.1";
const IPAD_SAFARI_MOBILE = "Mozilla/5.0 (iPad; CPU OS 12_5_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/12.1.2 Mobile/15E148 Safari/604.1";
const MAC_SAFARI = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15";
const MAC_CHROME = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const ANDROID_CHROME_PHONE = "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36";
const ANDROID_CHROME_TABLET = "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const ANDROID_PIXEL_7 = "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Mobile Safari/537.36";
const ANDROID_FIREFOX_TABLET = "Mozilla/5.0 (Android 14; Tablet; rv:127.0) Gecko/127.0 Firefox/127.0";
const ANDROID_FIREFOX_PHONE = "Mozilla/5.0 (Android 14; Mobile; rv:127.0) Gecko/127.0 Firefox/127.0";
const SAMSUNG_Z_FOLD = "Mozilla/5.0 (Linux; Android 14; SM-F946B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/25.0 Chrome/121.0.0.0 Mobile Safari/537.36";
const SAMSUNG_Z_FLIP = "Mozilla/5.0 (Linux; Android 14; SM-F741B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/25.0 Chrome/121.0.0.0 Mobile Safari/537.36";
const WINDOWS_CHROME = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const LINUX_FIREFOX = "Mozilla/5.0 (X11; Linux x86_64; rv:127.0) Gecko/20100101 Firefox/127.0";
const CHROMEOS = "Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

describe("detectWebDeviceKind", () => {
  const cases: readonly (readonly [string, WebDeviceEnvironment, ParticipantDeviceKind | undefined])[] = [
    ["iPhone Safari", { userAgent: IPHONE_SAFARI, maxTouchPoints: 5 }, "iphone"],
    ["iPhone Chrome", { userAgent: IPHONE_CHROME, maxTouchPoints: 5 }, "iphone"],
    ["an iPad that still sends an iPad user agent", { userAgent: IPAD_SAFARI_MOBILE, maxTouchPoints: 5 }, "ipad"],
    ["iPadOS Safari, which sends a Mac user agent", { userAgent: MAC_SAFARI, maxTouchPoints: 5 }, "ipad"],
    ["a Mac with a touch-less trackpad", { userAgent: MAC_SAFARI, maxTouchPoints: 0 }, "mac"],
    ["Mac Chrome without touch points reported", { userAgent: MAC_CHROME }, "mac"],
    ["Android Chrome on a phone", { userAgent: ANDROID_CHROME_PHONE, maxTouchPoints: 5 }, "android_phone"],
    ["a Pixel 7", { userAgent: ANDROID_PIXEL_7, maxTouchPoints: 5 }, "android_phone"],
    ["Android Chrome on a tablet, which has no Mobile token", { userAgent: ANDROID_CHROME_TABLET, maxTouchPoints: 5 }, "android_tablet"],
    ["Firefox on an Android tablet", { userAgent: ANDROID_FIREFOX_TABLET, maxTouchPoints: 5 }, "android_tablet"],
    ["Firefox on an Android phone", { userAgent: ANDROID_FIREFOX_PHONE, maxTouchPoints: 5 }, "android_phone"],
    ["a Galaxy Z Fold in Samsung Internet", { userAgent: SAMSUNG_Z_FOLD, maxTouchPoints: 5 }, "android_foldable"],
    ["a Galaxy Z Flip in Samsung Internet", { userAgent: SAMSUNG_Z_FLIP, maxTouchPoints: 5 }, "android_foldable"],
    ["Windows Chrome", { userAgent: WINDOWS_CHROME, maxTouchPoints: 0 }, "windows"],
    ["a touch-screen Windows laptop", { userAgent: WINDOWS_CHROME, maxTouchPoints: 10 }, "windows"],
    ["Linux Firefox", { userAgent: LINUX_FIREFOX }, "linux"],
    ["a Chromebook", { userAgent: CHROMEOS }, "chromeos"],
    ["a browser that says nothing", { userAgent: "" }, undefined],
  ];
  it.each(cases)("reads %s", (_name, environment, expected) => {
    expect(detectWebDeviceKind(environment)).toBe(expected);
  });

  it("trusts Client Hints over the user agent where a Chromium browser sends them", () => {
    expect(detectWebDeviceKind({ userAgent: ANDROID_CHROME_TABLET, userAgentData: { platform: "Android", mobile: false } })).toBe("android_tablet");
    expect(detectWebDeviceKind({ userAgent: ANDROID_CHROME_TABLET, userAgentData: { platform: "Android", mobile: true } })).toBe("android_phone");
    expect(detectWebDeviceKind({ userAgent: CHROMEOS, userAgentData: { platform: "Chrome OS", mobile: false } })).toBe("chromeos");
    expect(detectWebDeviceKind({ userAgent: "", userAgentData: { platform: "Windows", mobile: false } })).toBe("windows");
  });
});

describe("syncEntryUrl", () => {
  const base = "wss://sync.example.test/v1/sync";

  it("declares the device and asks to see everyone's", () => {
    const query = new URL(syncEntryUrl(base, null, true, "ipad")).searchParams;
    expect(query.get("device_kind")).toBe("ipad");
    expect(query.get("participant_device_kinds")).toBe("1");
  });

  it("still asks to see others' devices when this client cannot tell its own", () => {
    const query = new URL(syncEntryUrl(base, null, true)).searchParams;
    expect(query.has("device_kind")).toBe(false);
    expect(query.get("participant_device_kinds")).toBe("1");
  });
});
