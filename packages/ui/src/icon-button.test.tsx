// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { IconButton } from "./icon-button";

describe("IconButton", () => {
  afterEach(cleanup);

  it("renders a non-submitting button with its icon and accessible name", () => {
    render(<IconButton icon={<svg data-testid="icon" />} aria-label="Mute microphone" />);

    const button = screen.getByRole("button", { name: "Mute microphone" });
    expect(button.getAttribute("type")).toBe("button");
    expect(screen.getByTestId("icon")).toBeTruthy();
  });

  it("forwards clicks and honors an explicit type", () => {
    const onClick = vi.fn();
    render(<IconButton icon="×" aria-label="Close" type="submit" onClick={onClick} />);

    const button = screen.getByRole("button", { name: "Close" });
    expect(button.getAttribute("type")).toBe("submit");
    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledOnce();
  });
});
