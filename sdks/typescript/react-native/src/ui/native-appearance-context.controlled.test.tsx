// @vitest-environment happy-dom

import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

import { renderHook } from "../test-renderer";

vi.mock("react-native", () => ({
  StyleSheet: { absoluteFill: {}, create: (styles: unknown) => styles },
  View: ({ children }: { readonly children?: ReactNode }) => children,
}));

import { NativeAppearanceProvider, useNativeAppearance } from "./native-appearance-context";

describe("NativeAppearanceProvider controlled initial appearance", () => {
  it("updates palette and texture without replacing its child", () => {
    let initialAppearance = { palette: "light" as const, texture: "none" as const };
    const wrapper = ({ children }: { readonly children?: ReactNode }): React.JSX.Element => <NativeAppearanceProvider initialAppearance={initialAppearance}>{children}</NativeAppearanceProvider>;
    const { result, rerender } = renderHook(() => useNativeAppearance(), { wrapper });

    expect(result.current.appearance.palette).toBe("light");
    expect(result.current.appearance.texture).toBe("none");

    initialAppearance = { palette: "warm-porcelain", texture: "paper" };
    rerender();

    expect(result.current.appearance.palette).toBe("warm-porcelain");
    expect(result.current.appearance.texture).toBe("paper");
  });
});
