import { beforeEach, describe, expect, it, vi } from "bun:test";
import { render, fireEvent } from "@testing-library/react";
import { ControlButton } from "../../components/atomic/ControlButton";

describe("ControlButton", () => {
  const icon = <span>Icon</span>;
  const label = "Toggle Video";
  const vibrateSpy = vi.spyOn(navigator, "vibrate");

  beforeEach(() => {
    vibrateSpy.mockClear();
  });

  it("renders correctly", () => {
    const { getByRole, getByText } = render(<ControlButton icon={icon} label={label} />);
    const button = getByRole("button", { name: label });
    expect(button).toBeDefined();
    expect(getByText("Icon")).toBeDefined();
  });

  it("handles click events", () => {
    const onClick = vi.fn();
    const { getByRole } = render(<ControlButton icon={icon} label={label} onClick={onClick} />);
    const button = getByRole("button", { name: label });
    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(vibrateSpy).toHaveBeenCalledTimes(1);
  });

  it("can disable haptics per button", () => {
    const { getByRole } = render(<ControlButton icon={icon} label={label} haptic={false} />);
    fireEvent.click(getByRole("button", { name: label }));
    expect(vibrateSpy).not.toHaveBeenCalled();
  });

  it("renders label text when showLabel is true", () => {
    const { getByText } = render(<ControlButton icon={icon} label={label} showLabel />);
    expect(getByText(label)).toBeDefined();
  });

  it("applies active styles and aria-pressed", () => {
    const { getByRole } = render(<ControlButton icon={icon} label={label} active />);
    const button = getByRole("button", { name: label });
    expect(button).toHaveAttribute("aria-pressed", "true");
    expect(button).toHaveClass("bg-[var(--secondary)]");
  });

  it("applies danger styles", () => {
    const { getByRole } = render(<ControlButton icon={icon} label={label} danger />);
    const button = getByRole("button", { name: label });
    expect(button).toHaveClass("bg-[#dc2626]");
    expect(button).toHaveClass("text-white");
  });

  it("can be disabled", () => {
    const onClick = vi.fn();
    const { getByRole } = render(<ControlButton icon={icon} label={label} disabled onClick={onClick} />);
    const button = getByRole("button", { name: label });
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
    expect(vibrateSpy).not.toHaveBeenCalled();
  });
});
