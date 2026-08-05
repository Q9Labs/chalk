// @vitest-environment happy-dom

import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

import { act, renderHook } from "../test-support/test-renderer";

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

  it("notifies consumers when appearance controls change", () => {
    const onAppearanceChange = vi.fn();
    const wrapper = ({ children }: { readonly children?: ReactNode }): React.JSX.Element => <NativeAppearanceProvider onAppearanceChange={onAppearanceChange}>{children}</NativeAppearanceProvider>;
    const { result } = renderHook(() => useNativeAppearance(), { wrapper });

    act(() => result.current.setPalette("warm-porcelain"));
    act(() => result.current.setTexture("paper"));

    expect(onAppearanceChange).toHaveBeenNthCalledWith(1, { palette: "warm-porcelain", texture: "none" });
    expect(onAppearanceChange).toHaveBeenNthCalledWith(2, { palette: "warm-porcelain", texture: "paper" });
  });
});
