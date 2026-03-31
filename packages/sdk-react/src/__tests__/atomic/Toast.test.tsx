import { describe, it, expect, vi } from "vitest";
import { render, fireEvent, act } from "@testing-library/react";
import { Toast } from "../../components/atomic/Toast";

describe("Toast", () => {
  it("renders message correctly", () => {
    const { getByText } = render(<Toast message="Operation successful" />);
    expect(getByText("Operation successful")).toBeDefined();
  });

  it("renders correct icon for type", () => {
    const { getByRole } = render(<Toast message="Error occurred" type="error" />);
    expect(getByRole("alert")).toBeDefined();
  });

  it("calls onDismiss when close button is clicked", () => {
    const onDismiss = vi.fn();
    const { getByLabelText } = render(<Toast message="test" onDismiss={onDismiss} />);
    fireEvent.click(getByLabelText("Close"));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("calls onDismiss after duration", async () => {
    const onDismiss = vi.fn();
    render(<Toast message="test" onDismiss={onDismiss} duration={100} />);

    await new Promise((r) => setTimeout(r, 150));

    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("renders action button and handles clicks", () => {
    const onClick = vi.fn();
    const { getByText } = render(<Toast message="test" action={{ label: "Undo", onClick }} />);
    const actionBtn = getByText("Undo");
    fireEvent.click(actionBtn);
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
