// @vitest-environment happy-dom

import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { useConferenceDuration } from "./use-conference-duration";

describe("useConferenceDuration", () => {
  it("ticks while live and cleans up across state changes and unmount", () => {
    vi.useFakeTimers();
    const { result, rerender, unmount } = renderHook(({ state }) => useConferenceDuration(state), { initialProps: { state: "joining" as const } });

    expect(result.current).toBe(0);
    rerender({ state: "live" });
    act(() => vi.advanceTimersByTime(2_500));
    expect(result.current).toBe(2);

    rerender({ state: "reconnecting" });
    act(() => vi.advanceTimersByTime(2_000));
    expect(result.current).toBe(2);

    rerender({ state: "live" });
    act(() => vi.advanceTimersByTime(1_000));
    expect(result.current).toBe(3);

    unmount();
    act(() => vi.advanceTimersByTime(1_000));
    expect(result.current).toBe(3);
    vi.useRealTimers();
  });
});
