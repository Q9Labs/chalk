import type { ChalkSessionSnapshot, ChalkSessionStore } from "@q9labsai/chalk-client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ store: null as ChalkSessionStore | null }));

vi.mock("react", () => ({
  useCallback: <T>(callback: T) => callback,
  useMemo: <T>(factory: () => T) => factory(),
  useRef: <T>(value: T) => ({ current: value }),
  useSyncExternalStore: (_subscribe: unknown, getSnapshot: () => unknown) => getSnapshot(),
}));

vi.mock("../context/chalk-provider", () => ({
  useChalkSession: () => {
    if (!state.store) throw new Error("useChalkSession must be used within ChalkProvider");
    return state.store;
  },
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
    const { useChalkActions } = await import("./useChalkActions");
    const { useChalkSelector } = await import("./useChalkSelector");
    const { useChalkSnapshot } = await import("./useChalkSnapshot");

    expect(useChalkSnapshot()).toBe(snapshot);
    expect(useChalkSelector((value) => value.state)).toBe("live");
    await useChalkActions().sendReaction("🎉");
    expect(sendReaction).toHaveBeenCalledWith("🎉");
  });

  it("preserves the explicit visible sequence when marking chat read", async () => {
    const markChatRead = vi.fn(async () => null);
    state.store = {
      getSnapshot: () => ({ state: "live" }) as ChalkSessionSnapshot,
      subscribe: vi.fn(() => () => undefined),
      markChatRead,
    } as unknown as ChalkSessionStore;
    const { useChalkActions } = await import("./useChalkActions");

    await useChalkActions().markChatRead("18446744073709551615");

    expect(markChatRead).toHaveBeenCalledWith("18446744073709551615");
  });

  it("fails closed when the provider has no canonical session store", async () => {
    const { useChalkActions } = await import("./useChalkActions");
    const { useChalkSelector } = await import("./useChalkSelector");
    const { useChalkSnapshot } = await import("./useChalkSnapshot");

    expect(() => useChalkSnapshot()).toThrow(/within ChalkProvider/u);
    expect(() => useChalkSelector((snapshot) => snapshot.state)).toThrow(/within ChalkProvider/u);
    expect(() => useChalkActions()).toThrow(/within ChalkProvider/u);
  });
});
