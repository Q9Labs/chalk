// @vitest-environment happy-dom

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { StatusPill } from "./StatusPill";

describe("StatusPill", () => {
  it("maps retrying evidence to the live design-system tone", () => {
    const { container } = render(<StatusPill state="retrying" />);

    expect(screen.getByText("retrying")).toBeTruthy();
    expect(container.querySelector('[data-tone="live"]')).toBeTruthy();
    expect(screen.getByText("state").classList.contains("sr-only")).toBe(true);
  });
});
