// @vitest-environment happy-dom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { ProgressBar } from "./progress-bar";

describe("ProgressBar", () => {
  afterEach(cleanup);

  it("exposes progressbar semantics scaled against a custom max", () => {
    render(<ProgressBar value={30} max={60} />);

    const bar = screen.getByRole("progressbar");
    expect(bar.getAttribute("aria-valuenow")).toBe("30");
    expect(bar.getAttribute("aria-valuemax")).toBe("60");
    expect(bar.style.width).toBe("50%");
  });

  it("clamps overflow to 100% and shows the rounded label when asked", () => {
    render(<ProgressBar value={250} showLabel />);

    expect(screen.getByRole("progressbar").style.width).toBe("100%");
    expect(screen.getByText("100%")).toBeTruthy();
  });
});
