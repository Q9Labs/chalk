import { SpaceClientError, type ErrorCode } from "@q9labsai/chalk-client";
import { describe, expect, it } from "vitest";
import type { AccessEnvironment, PermissionAnswer } from "./model";
import { deviceAccessReason, detectBrowser, detectPlatform } from "./resolve";

const failure = (code: ErrorCode, permissionBlock?: "system") => new SpaceClientError({ code, recoverable: true, message: code, permissionBlock });
const env = (permission: PermissionAnswer, platform: AccessEnvironment["platform"] = "mac"): AccessEnvironment => ({ browser: "chrome", platform, permission });

describe("deviceAccessReason", () => {
  it("blames the browser when the site is denied or never asked", () => {
    for (const permission of ["denied", "prompt", "unknown"] as const) {
      expect(deviceAccessReason(failure("media.permission_denied"), "microphone", env(permission))).toEqual({ kind: "blocked-browser", browser: "chrome" });
    }
  });

  it("blames the operating system when the browser already allows the site", () => {
    expect(deviceAccessReason(failure("media.permission_denied"), "camera", env("granted", "mac"))).toEqual({ kind: "blocked-system", platform: "mac", browser: "chrome" });
    expect(deviceAccessReason(failure("media.permission_denied"), "camera", env("granted", "windows"))).toEqual({ kind: "blocked-system", platform: "windows", browser: "chrome" });
  });

  it("blames the operating system when Chrome says so, even if the permission cannot be read", () => {
    expect(deviceAccessReason(failure("media.permission_denied", "system"), "microphone", env("unknown", "windows"))).toMatchObject({ kind: "blocked-system", platform: "windows" });
  });

  it("falls back to the browser steps on a platform with no settings link", () => {
    expect(deviceAccessReason(failure("media.permission_denied", "system"), "microphone", env("unknown", "other"))).toMatchObject({ kind: "blocked-browser" });
  });

  it("maps busy and missing devices whatever the permission is", () => {
    expect(deviceAccessReason(failure("media.device_busy"), "camera", env("granted"))).toEqual({ kind: "busy" });
    expect(deviceAccessReason(failure("media.device_not_found"), "microphone", env("denied"))).toEqual({ kind: "missing" });
  });

  it("stays silent when the person cancels the screen picker", () => {
    expect(deviceAccessReason(failure("media.permission_denied"), "screen", env("unknown"))).toBeNull();
    expect(deviceAccessReason(failure("media.permission_denied"), "screen", env("granted"))).toBeNull();
  });

  it("shows the macOS card for screen sharing only when the system refused", () => {
    expect(deviceAccessReason(failure("media.permission_denied", "system"), "screen", env("unknown", "mac"))).toMatchObject({ kind: "blocked-system", platform: "mac" });
    expect(deviceAccessReason(failure("media.permission_denied", "system"), "screen", env("unknown", "windows"))).toBeNull();
  });

  it("ignores failures that are not about device access", () => {
    expect(deviceAccessReason(failure("client.internal_error"), "microphone", env("denied"))).toBeNull();
    expect(deviceAccessReason(failure("media.device_busy"), "screen", env("denied"))).toBeNull();
  });
});

describe("browser and platform detection", () => {
  const chromeMac = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
  const safariMac = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15";
  const firefoxWin = "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:132.0) Gecko/20100101 Firefox/132.0";
  const edgeWin = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0";
  const chromeAndroid = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36";

  it("tells the four browsers apart", () => {
    expect([chromeMac, safariMac, firefoxWin, edgeWin].map(detectBrowser)).toEqual(["chrome", "safari", "firefox", "edge"]);
  });

  it("finds the platform, and gives no settings link on phones or Linux", () => {
    expect([chromeMac, firefoxWin, chromeAndroid, "Mozilla/5.0 (X11; Linux x86_64)"].map(detectPlatform)).toEqual(["mac", "windows", "other", "other"]);
  });
});
