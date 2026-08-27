// @vitest-environment happy-dom

import { act, cleanup, render } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, describe, expect, it } from "vitest";

import { Copy01Icon, type Copy01IconHandle } from "./index";

afterEach(cleanup);

describe("animated icon collection", () => {
  it("exposes imperative animation controls without changing SVG semantics", () => {
    const ref = createRef<Copy01IconHandle>();
    const view = render(<Copy01Icon ref={ref} size={24} role="img" aria-label="Copy" />);

    const svg = view.getByRole("img", { name: "Copy" });
    expect(svg).toHaveAttribute("width", "24");
    expect(svg).toHaveAttribute("height", "24");

    if (!ref.current) throw new Error("Copy icon animation controls were not attached");

    act(() => ref.current?.startAnimation());
    act(() => ref.current?.stopAnimation());
  });
});
