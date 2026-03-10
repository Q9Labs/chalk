import React from "react";
import { act, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "bun:test";
import { LoadingScreen } from "../../components/full/LoadingScreen";

describe("LoadingScreen", () => {
  it("renders correctly with default message", () => {
    const { getByText } = render(<LoadingScreen />);
    expect(getByText("Loading...")).toBeDefined();
  });

  it("renders with custom message", () => {
    const customMessage = "Joining the Matrix...";
    const { getByText } = render(<LoadingScreen message={customMessage} />);
    expect(getByText(customMessage)).toBeDefined();
  });

  it("renders a polite status region", () => {
    const { container } = render(<LoadingScreen />);
    expect(container.firstChild).toBeDefined();
    expect(container.querySelector('[role="status"]')).toBeDefined();
  });

  it("rotates supporting messages", async () => {
    vi.useFakeTimers();

    const supportingMessages = ["Checking devices...", "Syncing settings...", "Almost there..."];
    const { getByText, queryByText } = render(<LoadingScreen message="Joining room..." supportingMessages={supportingMessages} />);

    expect(getByText("Joining room...")).toBeDefined();

    await act(async () => {
      vi.advanceTimersByTime(1800);
    });

    expect(queryByText("Joining room...")).toBeNull();
    expect(getByText("Checking devices...")).toBeDefined();
  });
});

afterEach(() => {
  vi.useRealTimers();
});
