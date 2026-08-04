import { describe, expect, it, vi } from "vitest";

import { clearOnboardingState, isOnboardingComplete, loadOnboardingState, ONBOARDING_STORAGE_KEY, parseOnboardingState, resolveOnboardingLaunchSurface, saveOnboardingState, type OnboardingStorage } from "./onboarding-store";

function createStorage(initialValue: string | null = null): OnboardingStorage & { value: string | null } {
  let value = initialValue;
  return {
    getItem: vi.fn(async () => value),
    removeItem: vi.fn(async () => {
      value = null;
    }),
    setItem: vi.fn(async (_key, nextValue) => {
      value = nextValue;
    }),
    get value() {
      return value;
    },
  };
}

describe("onboarding state", () => {
  it("treats malformed or incomplete storage as a fresh install", () => {
    expect(parseOnboardingState(null)).toEqual({ completed: false, displayName: null });
    expect(parseOnboardingState("not-json")).toEqual({ completed: false, displayName: null });
    expect(parseOnboardingState(JSON.stringify({ completed: false }))).toEqual({ completed: false, displayName: null });
    expect(resolveOnboardingLaunchSurface({ completed: false, displayName: null })).toBe("onboarding");
  });

  it("normalizes and persists a completed display name", async () => {
    const storage = createStorage();

    await expect(saveOnboardingState("  Nora Williams  ", storage)).resolves.toEqual({ completed: true, displayName: "Nora Williams" });
    await expect(loadOnboardingState(storage)).resolves.toEqual({ completed: true, displayName: "Nora Williams" });
    expect(storage.setItem).toHaveBeenCalledWith(ONBOARDING_STORAGE_KEY, JSON.stringify({ completed: true, displayName: "Nora Williams" }));
    expect(isOnboardingComplete(await loadOnboardingState(storage))).toBe(true);
    expect(resolveOnboardingLaunchSurface(await loadOnboardingState(storage))).toBe("home");
  });

  it("clears the completion marker for a dev/test first-run reset", async () => {
    const storage = createStorage(JSON.stringify({ completed: true, displayName: "Nora" }));

    await clearOnboardingState(storage);

    expect(storage.removeItem).toHaveBeenCalledWith(ONBOARDING_STORAGE_KEY);
    await expect(loadOnboardingState(storage)).resolves.toEqual({ completed: false, displayName: null });
  });
});
