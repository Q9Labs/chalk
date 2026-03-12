import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { usePwaInstall } from "../../hooks/ui/usePwaInstall";

describe("usePwaInstall", () => {
  const originalUserAgent = navigator.userAgent;
  const originalMatchMedia = window.matchMedia;

  beforeEach(() => {
    Object.defineProperty(navigator, "userAgent", {
      configurable: true,
      value: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
    });

    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: query === "(display-mode: standalone)" ? false : false,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })) as typeof window.matchMedia;
  });

  afterEach(() => {
    Object.defineProperty(navigator, "userAgent", {
      configurable: true,
      value: originalUserAgent,
    });

    window.matchMedia = originalMatchMedia;
  });

  it("exposes the native install prompt when the browser fires beforeinstallprompt", async () => {
    const prompt = vi.fn().mockResolvedValue(undefined);
    const userChoice = Promise.resolve({
      outcome: "accepted" as const,
      platform: "web",
    });

    const { result } = renderHook(() => usePwaInstall());

    const event = new Event("beforeinstallprompt") as Event & {
      prompt: typeof prompt;
      userChoice: typeof userChoice;
      preventDefault: () => void;
    };
    event.prompt = prompt;
    event.userChoice = userChoice;
    event.preventDefault = vi.fn();

    act(() => {
      window.dispatchEvent(event);
    });

    expect(result.current.canInstall).toBe(true);
    expect(result.current.hasNativePrompt).toBe(true);
    expect(result.current.requiresManualInstall).toBe(false);

    await act(async () => {
      const choice = await result.current.promptInstall();
      expect(choice?.outcome).toBe("accepted");
    });

    expect(prompt).toHaveBeenCalledTimes(1);
    expect(result.current.isInstalled).toBe(true);
  });

  it("falls back to manual install guidance on iPhone Safari", () => {
    Object.defineProperty(navigator, "userAgent", {
      configurable: true,
      value: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1",
    });

    const { result } = renderHook(() => usePwaInstall());

    expect(result.current.canInstall).toBe(true);
    expect(result.current.hasNativePrompt).toBe(false);
    expect(result.current.installPlatform).toBe("ios-safari");
    expect(result.current.requiresManualInstall).toBe(true);
  });

  it("detects desktop Safari dock installs as a manual path", () => {
    Object.defineProperty(navigator, "userAgent", {
      configurable: true,
      value: "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15",
    });

    const { result } = renderHook(() => usePwaInstall());

    expect(result.current.canInstall).toBe(true);
    expect(result.current.hasNativePrompt).toBe(false);
    expect(result.current.installPlatform).toBe("mac-safari");
    expect(result.current.requiresManualInstall).toBe(true);
  });

  it("starts installed when the browser is already in standalone mode", () => {
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: query === "(display-mode: standalone)",
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })) as typeof window.matchMedia;

    const { result } = renderHook(() => usePwaInstall());

    expect(result.current.isInstalled).toBe(true);
    expect(result.current.canInstall).toBe(false);
    expect(result.current.installPlatform).toBe("desktop");
  });

  it("subscribes to legacy media query listeners when addEventListener is unavailable", () => {
    const addListener = vi.fn();
    const removeListener = vi.fn();

    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: query === "(display-mode: standalone)" ? false : false,
      media: query,
      addListener,
      removeListener,
    })) as typeof window.matchMedia;

    const { unmount } = renderHook(() => usePwaInstall());

    expect(addListener).toHaveBeenCalledTimes(1);

    unmount();
    expect(removeListener).toHaveBeenCalledTimes(1);
  });
});
