import { describe, it, expect, vi } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { ConnectionLostOverlay } from "../../components/composite/ConnectionLostOverlay";

describe("ConnectionLostOverlay", () => {
  it("renders correctly when visible", () => {
    const { getByText } = render(<ConnectionLostOverlay isVisible={true} status="reconnecting" />);
    expect(getByText("Connection lost. Reconnecting...")).toBeDefined();
  });

  it("renders failed state with actions", () => {
    const onRetry = vi.fn();
    const { getByText } = render(<ConnectionLostOverlay isVisible={true} status="failed" onRetry={onRetry} supportCode="CHK-20260302-111111-001" />);
    expect(getByText("Connection Failed")).toBeDefined();
    expect(getByText("Support Code")).toBeDefined();
    expect(getByText("CHK-20260302-111111-001")).toBeDefined();
    fireEvent.click(getByText("Try Again"));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("returns null when not visible", () => {
    const { container } = render(<ConnectionLostOverlay isVisible={false} status="connecting" />);
    expect(container.firstChild).toBeNull();
  });
});
