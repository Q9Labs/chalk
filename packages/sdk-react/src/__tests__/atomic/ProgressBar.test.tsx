import { describe, it, expect } from "bun:test";
import { render } from "@testing-library/react";
import { ProgressBar } from "../../components/atomic/ProgressBar";

describe("ProgressBar", () => {
  it("renders correctly with default values", () => {
    const { getByRole } = render(<ProgressBar value={50} />);
    const bar = getByRole("progressbar");
    expect(bar).toHaveAttribute("aria-valuenow", "50");
    expect(bar.style.width).toBe("50%");
  });

  it("calculates percentage correctly with max", () => {
    const { getByRole } = render(<ProgressBar value={25} max={50} />);
    const bar = getByRole("progressbar");
    expect(bar.style.width).toBe("50%");
  });

  it("shows label when showLabel is true", () => {
    const { getByText } = render(<ProgressBar value={75} showLabel />);
    expect(getByText("75%")).toBeDefined();
  });

  it("applies variant colors", () => {
    const { getByRole } = render(<ProgressBar value={50} variant="success" />);
    expect(getByRole("progressbar")).toHaveClass("bg-success");
  });

  it("clamps values between 0 and 100%", () => {
    const { getByRole, rerender } = render(<ProgressBar value={150} />);
    expect(getByRole("progressbar").style.width).toBe("100%");

    rerender(<ProgressBar value={-50} />);
    expect(getByRole("progressbar").style.width).toBe("0%");
  });
});
