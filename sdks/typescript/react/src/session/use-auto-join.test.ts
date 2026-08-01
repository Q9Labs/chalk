// @vitest-environment happy-dom

import { renderHook } from "@testing-library/react";
import { createElement, StrictMode, type PropsWithChildren } from "react";
import { describe, expect, it, vi } from "vitest";

import { useAutoJoin } from "./use-auto-join";

describe("useAutoJoin", () => {
  it("joins once across StrictMode effect replay and re-renders", () => {
    const join = vi.fn(() => Promise.resolve());
    const wrapper = ({ children }: PropsWithChildren) => createElement(StrictMode, null, children);
    const { rerender, unmount } = renderHook(() => useAutoJoin(join), { wrapper });

    rerender();
    expect(join).toHaveBeenCalledOnce();

    unmount();
    expect(join).toHaveBeenCalledOnce();
  });
});
