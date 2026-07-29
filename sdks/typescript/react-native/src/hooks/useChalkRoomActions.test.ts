import type { ChalkSessionSnapshot, ChalkSessionStore } from "@q9labsai/chalk-client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ store: null as ChalkSessionStore | null }));

vi.mock("react", () => ({
  useCallback: <T>(callback: T) => callback,
  useMemo: <T>(factory: () => T) => factory(),
  useSyncExternalStore: (_subscribe: unknown, getSnapshot: () => unknown) => getSnapshot(),
}));

vi.mock("../context/chalk-native-provider", () => ({
  useChalkSessionStore: () => state.store,
}));

describe("canonical native room-action hooks", () => {
  beforeEach(() => {
    state.store = null;
  });

  it("reads the canonical snapshot and delegates public actions to the injected store", async () => {
    const snapshot = { state: "live" } as ChalkSessionSnapshot;
    const sendReaction = vi.fn(async () => ({ reaction: "🎉" as const }));
    state.store = {
      getSnapshot: () => snapshot,
      subscribe: vi.fn(() => () => undefined),
      sendReaction,
    } as unknown as ChalkSessionStore;
    const { useChalkActions, useChalkSelector, useOptionalChalkSnapshot } = await import("./useChalkRoomActions");

    expect(useOptionalChalkSnapshot()).toBe(snapshot);
    expect(useChalkSelector((value) => value.state)).toBe("live");
    await useChalkActions().sendReaction("🎉");
    expect(sendReaction).toHaveBeenCalledWith("🎉");
  });

  it("fails closed when the provider has no canonical session store", async () => {
    const { useChalkActions, useChalkSelector, useOptionalChalkSnapshot } = await import("./useChalkRoomActions");

    expect(useOptionalChalkSnapshot()).toBeNull();
    expect(() => useChalkSelector((snapshot) => snapshot.state)).toThrow(/requires sessionStore/u);
    expect(() => useChalkActions()).toThrow(/requires sessionStore/u);
  });
});
