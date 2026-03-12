// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getThemeColor, readPwaInstallDismissal, registerPwaServiceWorker, shouldHidePwaPrompt, syncThemeColor, writePwaInstallDismissal } from "./pwa";

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
});
