// @vitest-environment happy-dom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { Spinner } from "./spinner";

describe("Spinner", () => {
  afterEach(cleanup);

  it("announces itself as a loading status", () => {
    render(<Spinner />);

    const spinner = screen.getByRole("status");
    expect(spinner.getAttribute("aria-label")).toBe("Loading");
    expect(spinner.className).toContain("animate-spin");
  });

  it("applies size classes and a custom color", () => {
    render(<Spinner size="xl" color="rgb(255, 0, 0)" />);

    const spinner = screen.getByRole("status");
    expect(spinner.className).toContain("h-12");
    expect(spinner.style.color).toBe("rgb(255, 0, 0)");
  });
});
