import React from "react";
import { act, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LoadingScreen } from "../../components/full/LoadingScreen";
import { getParticipantColor } from "../../utils/colorGenerator";

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

  it("uses the provided gradient preference for its ambient color", () => {
    const gradientPreference = { mode: "custom" as const, from: "#ff00aa", to: "#7c3aed" };
    const expectedPrimary = getParticipantColor("Hasan", gradientPreference).primary;
    const { container } = render(<LoadingScreen displayName="Hasan" gradientPreference={gradientPreference} />);

    expect(container.querySelector(".animate-pulse")).toHaveStyle({ backgroundColor: expectedPrimary });
  });

  it("rotates supporting messages", async () => {
    vi.useFakeTimers();

    const supportingMessages = ["Checking devices...", "Syncing settings...", "Testing your connection...", "Preparing your preview...", "Opening a low-latency route...", "Almost there..."];
    const { getByText, queryByText } = render(<LoadingScreen message="Joining room..." supportingMessages={supportingMessages} />);

    expect(getByText("Joining room...")).toBeDefined();

    await act(async () => {
      vi.advanceTimersByTime(1800);
    });

    expect(queryByText("Joining room...")).toBeNull();
    expect(getByText("Checking devices...")).toBeDefined();

    await act(async () => {
      vi.advanceTimersByTime(1800 * 5);
    });

    expect(getByText("Almost there...")).toBeDefined();
  });
});

afterEach(() => {
  vi.useRealTimers();
});
