// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { formatPwaBuildLabel, getPwaInstallPromptContent, getThemeColor, shouldHidePwaPrompt, syncThemeColor } from "./pwa";

describe("pwa helpers", () => {
  beforeEach(() => {
    document.head.innerHTML = '<meta name="theme-color" content="#000000" />';
  });

  afterEach(() => {
    document.head.innerHTML = "";
    vi.unstubAllGlobals();
  });

  it("maps app themes to the expected browser chrome colors", () => {
    expect(getThemeColor("dark")).toBe("#030303");
    expect(getThemeColor("light")).toBe("#ffffff");
    expect(getThemeColor("unknown")).toBe("#030303");
  });

  it("updates the theme-color meta tag", () => {
    syncThemeColor("dark");

    expect(document.querySelector('meta[name="theme-color"]')?.getAttribute("content")).toBe("#030303");
  });

  it("suppresses pwa prompts on immersive routes", () => {
    expect(shouldHidePwaPrompt("/room/algebra")).toBe(true);
    expect(shouldHidePwaPrompt("/share/token-123")).toBe(true);
    expect(shouldHidePwaPrompt("/dashboard")).toBe(false);
  });

  it("formats install copy for native and manual install surfaces", () => {
    expect(
      getPwaInstallPromptContent({
        hasNativePrompt: true,
        installPlatform: "desktop",
        requiresManualInstall: false,
      }),
    ).toMatchObject({
      badge: "Desktop install",
      ctaLabel: "Install app",
      title: "Install Chalk",
    });

    expect(
      getPwaInstallPromptContent({
        hasNativePrompt: false,
        installPlatform: "ios-safari",
        requiresManualInstall: true,
      }),
    ).toMatchObject({
      badge: "Safari Share -> Add to Home Screen",
      dismissLabel: "Got it",
      title: "Add Chalk to Home Screen",
    });

    expect(
      getPwaInstallPromptContent({
        hasNativePrompt: false,
        installPlatform: "mac-safari",
        requiresManualInstall: true,
      }),
    ).toMatchObject({
      badge: "Safari File -> Add to Dock",
      title: "Add Chalk to your Dock",
    });
  });

  it("formats build metadata labels", () => {
    expect(formatPwaBuildLabel({ commitHash: "abc1234", version: "0.1.0" })).toBe("v0.1.0 · abc1234");
    expect(formatPwaBuildLabel(null)).toBe("Fresh build");
  });

  it("ships chalk-branded web and mobile pwa icons", () => {
    const manifest = JSON.parse(readFileSync(resolve(process.cwd(), "public/manifest.json"), "utf8")) as {
      icons: Array<{ src: string; purpose?: string }>;
      shortcuts: Array<{ icons: Array<{ src: string }> }>;
    };
    const rootRouteSource = readFileSync(resolve(process.cwd(), "src/routes/__root.tsx"), "utf8");

    expect(manifest.icons.map((icon) => icon.src)).toEqual([
      "/favicon.ico",
      "/brand/chalk/chalk-icon-192.png",
      "/brand/chalk/chalk-icon-512.png",
      "/brand/chalk/chalk-icon-maskable-192.png",
      "/brand/chalk/chalk-icon-maskable-512.png",
    ]);
    expect(manifest.icons.map((icon) => icon.purpose ?? "default")).toEqual(["default", "any", "any", "maskable", "maskable"]);
    expect(manifest.shortcuts.flatMap((shortcut) => shortcut.icons.map((icon) => icon.src))).toEqual([
      "/brand/chalk/shortcut-new-192.png",
      "/brand/chalk/shortcut-dashboard-192.png",
    ]);
    expect(rootRouteSource).toContain('href: "/brand/chalk/apple-touch-icon.png"');
    expect(rootRouteSource).not.toContain('href: "/logo192.png"');
  });
});
