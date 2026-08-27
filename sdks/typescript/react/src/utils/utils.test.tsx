// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Copy01Icon } from "./animated-icons";

afterEach(cleanup);

describe("animated icon interaction bridge", () => {
  it("forwards control hover to a nested animated icon", () => {
    const onMouseEnter = vi.fn();
    const onMouseLeave = vi.fn();
    render(
      <button type="button">
        Copy
        <Copy01Icon aria-hidden="true" onMouseEnter={onMouseEnter} onMouseLeave={onMouseLeave} />
      </button>,
    );

    const button = screen.getByRole("button", { name: "Copy" });
    fireEvent.mouseOver(button);
    fireEvent.mouseOut(button);

    expect(onMouseEnter).toHaveBeenCalled();
    expect(onMouseLeave).toHaveBeenCalled();
  });
});
