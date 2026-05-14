import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { HandRaiseIndicator } from "../../components/atomic/HandRaiseIndicator";

describe("HandRaiseIndicator", () => {
  it("renders when raised is true", () => {
    const { getByRole } = render(<HandRaiseIndicator raised={true} />);
    expect(getByRole("status")).toHaveAttribute("aria-label", "Hand raised");
  });

  it("returns null when raised is false", () => {
    const { container } = render(<HandRaiseIndicator raised={false} />);
    expect(container.firstChild).toBeNull();
  });

  it("applies position classes", () => {
    const { container } = render(<HandRaiseIndicator raised={true} position="bottom-left" />);
    expect(container.firstChild).toHaveClass("bottom-2");
    expect(container.firstChild).toHaveClass("left-2");
  });

  it("applies custom size", () => {
    const { container } = render(<HandRaiseIndicator raised={true} size="lg" />);
    const icon = container.querySelector("svg");
    expect(icon).toHaveAttribute("width", "32");
  });
});
