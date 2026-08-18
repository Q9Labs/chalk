// @vitest-environment happy-dom

import { renderHook } from "@testing-library/react";
import type { PropsWithChildren } from "react";
import { describe, expect, it } from "vitest";

import { SkinProvider, useSkin } from "./skin-context";

describe("skin context", () => {
  it("defaults to chalk", () => {
    const { result } = renderHook(() => useSkin());

    expect(result.current).toBe("chalk");
  });

  it("reads a supplied classic skin", () => {
    const wrapper = ({ children }: PropsWithChildren) => <SkinProvider skin="classic">{children}</SkinProvider>;
    const { result } = renderHook(() => useSkin(), { wrapper });

    expect(result.current).toBe("classic");
  });
});
