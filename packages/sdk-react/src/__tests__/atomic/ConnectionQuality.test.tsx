import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { ConnectionQuality } from "../../components/atomic/ConnectionQuality";

describe("ConnectionQuality", () => {
  it("renders correctly", () => {
    const { getByRole } = render(<ConnectionQuality quality={3} />);
    expect(getByRole("status")).toHaveAttribute("aria-label", "Connection quality: Good");
  });

  it("shows label when showLabel is true", () => {
    const { getByText } = render(<ConnectionQuality quality={4} showLabel />);
    expect(getByText("Excellent")).toBeDefined();
  });

  it("renders all bars", () => {
    const { getByRole } = render(<ConnectionQuality quality={2} />);
    const status = getByRole("status");
    const bars = status.querySelectorAll("div");
    expect(bars.length).toBe(4);
  });

  it("clamps quality values", () => {
    const { getByRole, rerender } = render(<ConnectionQuality quality={5 as any} />);
    expect(getByRole("status")).toHaveAttribute("aria-label", "Connection quality: Excellent");

    rerender(<ConnectionQuality quality={0 as any} />);
    expect(getByRole("status")).toHaveAttribute("aria-label", "Connection quality: Poor");
  });
});
