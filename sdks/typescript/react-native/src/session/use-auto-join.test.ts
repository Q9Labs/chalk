// @vitest-environment happy-dom

import { StrictMode, createElement, type PropsWithChildren } from "react";
import { describe, expect, it, vi } from "vitest";

import { renderHook } from "../test-renderer";
import { useAutoJoin } from "./use-auto-join";

describe("useAutoJoin", () => {
  it("starts once across StrictMode effect replay, re-render, and unmount", () => {
    const begin = vi.fn(() => Promise.resolve());
    const wrapper = ({ children }: PropsWithChildren) => createElement(StrictMode, null, children);
    const { rerender, unmount } = renderHook(() => useAutoJoin(true, begin), { wrapper });

    rerender();
    expect(begin).toHaveBeenCalledOnce();

    unmount();
    expect(begin).toHaveBeenCalledOnce();
  });

  it("waits until enabled before starting", () => {
    const begin = vi.fn(() => Promise.resolve());
    const { rerender } = renderHook(({ enabled }) => useAutoJoin(enabled, begin), { initialProps: { enabled: false } });

    expect(begin).not.toHaveBeenCalled();
    rerender({ enabled: true });
    expect(begin).toHaveBeenCalledOnce();
  });
});
