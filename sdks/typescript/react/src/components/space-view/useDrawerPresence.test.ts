// @vitest-environment happy-dom

import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useDrawerPresence } from "./useDrawerPresence";

afterEach(() => {
  vi.useRealTimers();
});

describe("useDrawerPresence", () => {
  it("starts closed without a panel and open with one", () => {
    expect(renderHook(() => useDrawerPresence<string>(null, 200)).result.current).toEqual({ panel: null, state: "closed" });
    expect(renderHook(() => useDrawerPresence("chat", 200)).result.current).toEqual({ panel: "chat", state: "open" });
  });

  it("retains the last panel while closing, then clears it after the exit delay", () => {
    vi.useFakeTimers();
    const { result, rerender } = renderHook(({ panel }: { panel: string | null }) => useDrawerPresence(panel, 200), { initialProps: { panel: "chat" } });

    rerender({ panel: null });
    expect(result.current).toEqual({ panel: "chat", state: "closing" });

    act(() => {
      vi.advanceTimersByTime(199);
    });
    expect(result.current.state).toBe("closing");

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current).toEqual({ panel: null, state: "closed" });
  });

  it("swaps panels in place and reopens mid-close without flashing closed", () => {
    vi.useFakeTimers();
    const { result, rerender } = renderHook(({ panel }: { panel: string | null }) => useDrawerPresence(panel, 200), { initialProps: { panel: "chat" } });

    rerender({ panel: "participants" });
    expect(result.current).toEqual({ panel: "participants", state: "open" });

    rerender({ panel: null });
    rerender({ panel: "chat" });
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(result.current).toEqual({ panel: "chat", state: "open" });
  });

  it("closes immediately when the exit delay is zero", () => {
    vi.useFakeTimers();
    const { result, rerender } = renderHook(({ panel }: { panel: string | null }) => useDrawerPresence(panel, 0), { initialProps: { panel: "chat" } });

    rerender({ panel: null });
    act(() => {
      vi.advanceTimersByTime(0);
    });
    expect(result.current).toEqual({ panel: null, state: "closed" });
  });
});
