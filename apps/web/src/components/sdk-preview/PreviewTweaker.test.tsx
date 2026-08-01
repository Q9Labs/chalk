// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PreviewTweaker } from "./PreviewTweaker";

afterEach(cleanup);

describe("PreviewTweaker", () => {
  it("triggers interaction states and notification variants", () => {
    const onNotify = vi.fn();
    const onToggleHand = vi.fn();
    render(<PreviewTweaker onNotify={onNotify} onShowPeople={vi.fn()} onShowChat={vi.fn()} onShowScreenShare={vi.fn()} onShowWhiteboard={vi.fn()} onShowMeetingInfo={vi.fn()} onShowSettings={vi.fn()} onToggleHand={onToggleHand} />);

    fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    fireEvent.click(screen.getByRole("button", { name: "Raised hand" }));
    fireEvent.click(screen.getByRole("button", { name: "warning" }));

    expect(onToggleHand).toHaveBeenCalledOnce();
    expect(onNotify).toHaveBeenCalledWith("warning");
  });
});
