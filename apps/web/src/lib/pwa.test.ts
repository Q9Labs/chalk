// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { formatPwaBuildLabel, getPwaInstallPromptContent, getThemeColor, readPwaInstallDismissal, registerPwaServiceWorker, requestPwaBuildMeta, shouldHidePwaPrompt, syncThemeColor, writePwaInstallDismissal } from "./pwa";

describe("pwa helpers", () => {
  const originalServiceWorker = navigator.serviceWorker;
  const originalLocalStorage = window.localStorage;
  const resetDismissal = () => {
    window.localStorage?.removeItem?.("chalk-pwa-install-dismissed");
  };

  beforeEach(() => {
    document.head.innerHTML = '<meta name="theme-color" content="#000000" />';
    const storage = (() => {
      const store = new Map<string, string>();
      return {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => {
          store.set(key, value);
        },
        removeItem: (key: string) => {
          store.delete(key);
        },
      };
    })();

    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: storage,
    });
    resetDismissal();
    vi.stubGlobal("__COMMIT_HASH__", "test-build");
  });

  afterEach(() => {
    document.head.innerHTML = "";
    resetDismissal();

    if (originalServiceWorker) {
      Object.defineProperty(navigator, "serviceWorker", {
        configurable: true,
        value: originalServiceWorker,
      });
    } else {
      // @ts-expect-error - test cleanup
      delete navigator.serviceWorker;
    }

    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: originalLocalStorage,
    });

    vi.unstubAllGlobals();
  });

  it("maps app themes to the expected browser chrome colors", () => {
    expect(getThemeColor("dark")).toBe("#030303");
    expect(getThemeColor("light")).toBe("#ffffff");
    expect(getThemeColor("nord")).toBe("#2e3440");
    expect(getThemeColor("unknown")).toBe("#030303");
  });

  it("updates the theme-color meta tag", () => {
    syncThemeColor("nord");

    expect(document.querySelector('meta[name="theme-color"]')?.getAttribute("content")).toBe("#2e3440");
  });

  it("registers the service worker with the current build hash", async () => {
    const register = vi.fn().mockResolvedValue({ scope: "/" });

    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      value: { register },
    });

    await registerPwaServiceWorker();

    expect(register).toHaveBeenCalledWith("/sw.js?v=test-build", { scope: "/" });
  });

  it("suppresses pwa prompts on immersive routes", () => {
    expect(shouldHidePwaPrompt("/room/algebra")).toBe(true);
    expect(shouldHidePwaPrompt("/share/token-123")).toBe(true);
    expect(shouldHidePwaPrompt("/dashboard")).toBe(false);
  });

  it("persists install prompt dismissal", () => {
    writePwaInstallDismissal(true);
    expect(readPwaInstallDismissal()).toBe(true);

    writePwaInstallDismissal(false);
    expect(readPwaInstallDismissal()).toBe(false);
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

  it("requests build metadata from a waiting service worker", async () => {
    const worker = {
      postMessage(_message: unknown, transfer: Transferable[]) {
        const port = transfer[0] as MessagePort;
        port.postMessage({
          commitHash: "abc1234",
          version: "0.1.0",
        });
      },
    };

    await expect(requestPwaBuildMeta(worker)).resolves.toEqual({
      commitHash: "abc1234",
      version: "0.1.0",
    });
    expect(formatPwaBuildLabel({ commitHash: "abc1234", version: "0.1.0" })).toBe("v0.1.0 · abc1234");
    expect(formatPwaBuildLabel(null)).toBe("Fresh build");
  });

  it("ships chalk-branded web and mobile pwa icons", () => {
    const manifest = JSON.parse(readFileSync(resolve(process.cwd(), "public/manifest.json"), "utf8")) as {
      icons: Array<{ src: string; purpose?: string }>;
      shortcuts: Array<{ icons: Array<{ src: string }> }>;
    };
    const rootRouteSource = readFileSync(resolve(process.cwd(), "src/routes/__root.tsx"), "utf8");

    expect(manifest.icons.map((icon) => icon.src)).toEqual(["/favicon.ico", "/chalk-icon-192.png", "/chalk-icon-512.png", "/chalk-icon-maskable-192.png", "/chalk-icon-maskable-512.png"]);
    expect(manifest.icons.map((icon) => icon.purpose ?? "default")).toEqual(["default", "any", "any", "maskable", "maskable"]);
    expect(manifest.shortcuts.flatMap((shortcut) => shortcut.icons.map((icon) => icon.src))).toEqual(["/shortcut-new-192.png", "/shortcut-dashboard-192.png"]);
    expect(rootRouteSource).toContain('href: "/apple-touch-icon.png"');
    expect(rootRouteSource).not.toContain('href: "/logo192.png"');
  });
});
