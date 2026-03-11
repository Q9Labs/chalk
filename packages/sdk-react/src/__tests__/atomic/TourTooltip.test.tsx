import { describe, it, expect, vi } from "bun:test";
import { render, fireEvent } from "@testing-library/react";
import { TourTooltip } from "../../components/atomic/TourTooltip";

describe("TourTooltip", () => {
  const defaultProps = {
    title: "Welcome",
    description: "Welcome to the tour",
    step: 1,
    totalSteps: 3,
  };

  it("renders correctly", () => {
    const { getByText } = render(<TourTooltip {...defaultProps} />);
    expect(getByText("Welcome")).toBeDefined();
    expect(getByText("Welcome to the tour")).toBeDefined();
    expect(getByText(/Step 1 of 3/i)).toBeDefined();
  });

  it("handles navigation clicks", () => {
    const onNext = vi.fn();
    const onPrev = vi.fn();
    const { getByLabelText, rerender } = render(<TourTooltip {...defaultProps} onNext={onNext} onPrev={onPrev} />);

    fireEvent.click(getByLabelText("Next step"));
    expect(onNext).toHaveBeenCalledTimes(1);

    rerender(<TourTooltip {...defaultProps} step={2} onNext={onNext} onPrev={onPrev} />);
    fireEvent.click(getByLabelText("Previous step"));
    expect(onPrev).toHaveBeenCalledTimes(1);
  });

  it("handles skip action", () => {
    const onSkip = vi.fn();
    const { getByLabelText } = render(<TourTooltip {...defaultProps} onSkip={onSkip} />);
    fireEvent.click(getByLabelText("Skip tour"));
    expect(onSkip).toHaveBeenCalledTimes(1);
  });

  it('renders "Got it" on last step', () => {
    const { getByText } = render(<TourTooltip {...defaultProps} step={3} />);
    expect(getByText("Got it")).toBeDefined();
  });
});
