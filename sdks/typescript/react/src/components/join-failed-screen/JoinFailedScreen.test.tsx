// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { JoinFailedScreen } from "./JoinFailedScreen";

afterEach(cleanup);

describe("JoinFailedScreen", () => {
  it("uses the canonical title and exposes the failure as an alert and status", () => {
    render(<JoinFailedScreen message="The Space is unavailable right now." onRetry={vi.fn()} onBack={vi.fn()} />);

    expect(screen.getByRole("heading", { name: "Couldn’t enter the Space" })).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("The Space is unavailable right now.");
    expect(screen.getByRole("status")).toHaveTextContent("The Space is unavailable right now.");
  });

  it("renders custom title and a selectable support code", () => {
    render(<JoinFailedScreen title="Access denied" message="You are not allowed to enter this Space." supportCode="space-denied-7K4P" onRetry={vi.fn()} onBack={vi.fn()} />);

    expect(screen.getByRole("heading", { name: "Access denied" })).toBeInTheDocument();
    expect(screen.getByText("space-denied-7K4P", { selector: "code" })).toHaveClass("select-text");
  });

  it("runs retry and back actions from their visible buttons", () => {
    const onRetry = vi.fn();
    const onBack = vi.fn();
    render(<JoinFailedScreen message="Sync unavailable" onRetry={onRetry} onBack={onBack} />);

    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    fireEvent.click(screen.getByRole("button", { name: "Back to Entrance" }));

    expect(onRetry).toHaveBeenCalledOnce();
    expect(onBack).toHaveBeenCalledOnce();
  });
});
