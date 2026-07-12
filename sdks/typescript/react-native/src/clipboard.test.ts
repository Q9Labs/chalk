import { describe, expect, it, vi } from "vitest";
import { createClipboardTextStore } from "./clipboard-store";

vi.mock("react-native", () => ({
  AppState: { addEventListener: vi.fn(() => ({ remove: vi.fn() })) },
  NativeModules: { ChalkRuntimeInfo: { isSimulator: false } },
  Platform: { OS: "ios" },
}));

describe("clipboard invite suggestion hook", () => {
  it("exposes the extracted clipboard suggestion hook", async () => {
    const { useClipboardInviteSuggestion } = await import("./clipboard");

    expect(typeof useClipboardInviteSuggestion).toBe("function");
  });
});

describe("createClipboardTextStore", () => {
  it("refreshes on subscription and active app-state events, then stops after unsubscribe", async () => {
    let appStateListener: ((nextState: string) => void) | undefined;
    const removeAppStateListener = vi.fn();
    const clipboard = {
      hasStringAsync: vi.fn().mockResolvedValue(true),
      getStringAsync: vi.fn().mockResolvedValue("chalk invite"),
    };
    const store = createClipboardTextStore({
      clipboard,
      shouldReadClipboard: true,
      subscribeToAppState: (listener) => {
        appStateListener = listener;
        return { remove: removeAppStateListener };
      },
    });
    const listener = vi.fn();

    const unsubscribe = store.subscribe(listener);
    await Promise.resolve();
    await Promise.resolve();

    expect(store.getSnapshot()).toBe("chalk invite");
    expect(listener).toHaveBeenCalledOnce();

    appStateListener?.("active");
    await Promise.resolve();
    await Promise.resolve();

    expect(clipboard.hasStringAsync).toHaveBeenCalledTimes(2);

    unsubscribe();
    expect(removeAppStateListener).toHaveBeenCalledOnce();
    appStateListener?.("active");
    await Promise.resolve();
    await Promise.resolve();

    expect(clipboard.hasStringAsync).toHaveBeenCalledTimes(2);
  });

  it("does not read the clipboard when the platform policy disables automatic reads", async () => {
    const clipboard = {
      hasStringAsync: vi.fn(),
      getStringAsync: vi.fn(),
    };
    const subscribeToAppState = vi.fn();
    const store = createClipboardTextStore({
      clipboard,
      shouldReadClipboard: false,
      subscribeToAppState,
    });

    const unsubscribe = store.subscribe(vi.fn());
    await Promise.resolve();

    expect(store.getSnapshot()).toBeNull();
    expect(clipboard.hasStringAsync).not.toHaveBeenCalled();
    expect(subscribeToAppState).not.toHaveBeenCalled();

    unsubscribe();
  });
});
