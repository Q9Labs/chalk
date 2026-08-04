// @vitest-environment happy-dom

import { describe, expect, it } from "vitest";

import { act, renderHook } from "../test-renderer";
import { useLayout } from "./useLayout";

describe("useLayout", () => {
  it("synchronizes a controlled layout without replacing the hook", () => {
    const { result, rerender } = renderHook(({ layout }) => useLayout("grid", layout), { initialProps: { layout: "grid" as const } });

    expect(result.current.layout).toBe("grid");
    act(() => rerender({ layout: "presentation" }));
    expect(result.current.layout).toBe("presentation");
  });
});
