// @vitest-environment happy-dom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { ScreenShareMock } from "./ScreenShareMock";

afterEach(cleanup);

describe("ScreenShareMock", () => {
  it("renders the realistic shared product document", () => {
    render(<ScreenShareMock />);

    expect(screen.getByRole("heading", { name: "Design review" })).toBeTruthy();
    expect(screen.getByText("Today’s decisions")).toBeTruthy();
    expect(screen.getByText("42 ms")).toBeTruthy();
  });

  it("collapses the Space rail on narrow screens", () => {
    const { container } = render(<ScreenShareMock />);

    const stage = container.querySelector(".grid-cols-1.sm\\:grid-cols-\\[150px_minmax\\(0\\,1fr\\)\\]");
    expect(stage).toBeTruthy();
    expect(container.querySelector("aside")?.className).toContain("hidden");
    expect(container.querySelector("aside")?.className).toContain("sm:block");
  });
});
