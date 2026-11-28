import { describe, expect, it } from "vitest";
import type { ClientFailure } from "@q9labsai/chalk-client";
import { accessTooltip, cardCopy } from "./card-copy";
import type { AccessEnvironment, DeviceAccessReason } from "./model";
import { isDeviceAccessFailure } from "./model";
import { deviceAccessReason, detectBrowser, detectPlatform } from "./resolve";

const AGENTS = {
  iphoneSafari: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1",
  iphoneChrome: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/130.0.6723.90 Mobile/15E148 Safari/604.1",
  ipadDesktopSafari: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Safari/605.1.15",
  androidChrome: "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36",
  macChrome: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
  windowsEdge: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0",
} as const;

function failure(code: ClientFailure["code"], extra: Partial<ClientFailure> = {}): ClientFailure {
  return { code, recoverable: true, message: code, ...extra };
}
const denied = failure("media.permission_denied");
const env = (agent: keyof typeof AGENTS, permission: AccessEnvironment["permission"] = "denied", touchPoints = 0): AccessEnvironment => ({ browser: detectBrowser(AGENTS[agent]), platform: detectPlatform(AGENTS[agent], touchPoints), permission });

describe("detecting the browser and the platform", () => {
  it("tells iPhone and iPad browsers apart from Mac and Android", () => {
    expect(detectPlatform(AGENTS.iphoneSafari)).toBe("ios");
    expect(detectPlatform(AGENTS.iphoneChrome)).toBe("ios");
    expect(detectPlatform(AGENTS.androidChrome)).toBe("android");
    expect(detectPlatform(AGENTS.macChrome)).toBe("mac");
    expect(detectPlatform(AGENTS.windowsEdge)).toBe("windows");
  });

  it("reads an iPad that asks for desktop sites by its touch screen", () => {
    expect(detectPlatform(AGENTS.ipadDesktopSafari, 5)).toBe("ios");
    expect(detectPlatform(AGENTS.ipadDesktopSafari, 0)).toBe("mac");
  });

  it("names Chrome on iPhone as Chrome, not Safari", () => {
    expect(detectBrowser(AGENTS.iphoneChrome)).toBe("chrome");
    expect(detectBrowser(AGENTS.iphoneSafari)).toBe("safari");
    expect(detectBrowser(AGENTS.windowsEdge)).toBe("edge");
  });
});

describe("which card a refusal gets", () => {
  it.each([
    ["iphoneSafari", { kind: "blocked-browser", browser: "safari", platform: "ios" }],
    ["iphoneChrome", { kind: "blocked-app", browser: "chrome" }],
    ["androidChrome", { kind: "blocked-browser", browser: "chrome", platform: "android" }],
    ["macChrome", { kind: "blocked-browser", browser: "chrome", platform: "mac" }],
    ["windowsEdge", { kind: "blocked-browser", browser: "edge", platform: "windows" }],
  ] as const)("shows %s the steps for its own browser when the site is blocked", (agent, expected) => {
    expect(deviceAccessReason(denied, "microphone", env(agent))).toEqual(expected);
  });

  it("sends a refusal under a granted browser permission to the operating system", () => {
    expect(deviceAccessReason(denied, "camera", env("macChrome", "granted"))).toEqual({ kind: "blocked-system", platform: "mac", browser: "chrome" });
    expect(deviceAccessReason(denied, "camera", env("windowsEdge", "granted"))).toEqual({ kind: "blocked-system", platform: "windows", browser: "edge" });
    expect(deviceAccessReason(denied, "microphone", env("androidChrome", "granted"))).toEqual({ kind: "blocked-system", platform: "android", browser: "chrome" });
  });

  it("names the operating system when Chrome says it refused capture", () => {
    expect(deviceAccessReason(failure("media.permission_denied", { permissionBlock: "system" }), "microphone", env("macChrome"))).toMatchObject({ kind: "blocked-system", platform: "mac" });
  });

  it("names the platform for an app that is using the device", () => {
    expect(deviceAccessReason(failure("media.device_busy"), "camera", env("windowsEdge"))).toEqual({ kind: "busy", platform: "windows" });
    expect(deviceAccessReason(failure("media.device_busy"), "microphone", env("iphoneSafari"))).toEqual({ kind: "busy", platform: "ios" });
  });

  it("gives a remembered device that is gone its own card, where no card showed before", () => {
    const gone = failure("media.device_constraint_invalid");
    expect(isDeviceAccessFailure(gone, "camera")).toBe(true);
    expect(isDeviceAccessFailure(gone, "screen")).toBe(false);
    expect(deviceAccessReason(gone, "camera", env("macChrome"))).toEqual({ kind: "unavailable" });
  });

  it("treats a refused screen as a closed picker, unless macOS says it refused", () => {
    expect(deviceAccessReason(denied, "screen", env("windowsEdge"))).toEqual({ kind: "screen-declined" });
    expect(deviceAccessReason(denied, "screen", env("macChrome"))).toEqual({ kind: "screen-declined" });
    expect(deviceAccessReason(failure("media.permission_denied", { permissionBlock: "system" }), "screen", env("macChrome"))).toEqual({ kind: "blocked-system", platform: "mac", browser: "chrome" });
    expect(deviceAccessReason(denied, "screen", env("iphoneSafari"))).toBeNull();
  });
});

describe("what each card says", () => {
  const reasons: readonly [string, DeviceAccessReason][] = [
    ["iPhone Safari", { kind: "blocked-browser", browser: "safari", platform: "ios" }],
    ["iPhone Chrome", { kind: "blocked-app", browser: "chrome" }],
    ["Android Chrome", { kind: "blocked-browser", browser: "chrome", platform: "android" }],
    ["Android system", { kind: "blocked-system", platform: "android", browser: "chrome" }],
    ["Mac system", { kind: "blocked-system", platform: "mac", browser: "chrome" }],
    ["Windows system", { kind: "blocked-system", platform: "windows", browser: "edge" }],
    ["Windows busy", { kind: "busy", platform: "windows" }],
    ["iPhone busy", { kind: "busy", platform: "ios" }],
    ["unavailable", { kind: "unavailable" }],
  ];

  it.each(reasons)("%s names the device and says what to do", (_label, reason) => {
    const copy = cardCopy("microphone", reason);
    expect(copy.title.length).toBeGreaterThan(0);
    expect(copy.detail).toMatch(/\.$/);
    expect(accessTooltip("microphone", reason)).toMatch(/\.$/);
  });

  it("sends an iPhone Chrome user to iPhone Settings, not to a site menu Chrome does not have there", () => {
    const copy = cardCopy("camera", { kind: "blocked-app", browser: "chrome" });
    expect(copy.detail).toBe("Chrome needs camera access. Turn it on in iPhone Settings, then come back and try again.");
    expect(copy.note).toContain("Settings › Chrome");
  });

  it("tells a Mac user to reopen the browser after the system switch", () => {
    expect(cardCopy("screen", { kind: "blocked-system", platform: "mac", browser: "chrome" })).toMatchObject({ title: "Screen sharing is blocked by macOS", detail: "Turn on Google Chrome, then quit and reopen Chrome." });
  });

  it("names the closed picker for a screen share that did not start", () => {
    expect(cardCopy("screen", { kind: "screen-declined" }).title).toBe("Screen sharing didn’t start");
  });
});
