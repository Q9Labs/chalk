// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PreviewTweaker } from "./PreviewTweaker";

afterEach(cleanup);

describe("PreviewTweaker", () => {
  it("triggers interaction states and notification variants", () => {
    const onNotify = vi.fn();
    const onToggleHand = vi.fn();
    const onPaletteChange = vi.fn();
    const onTextureChange = vi.fn();
    render(
      <PreviewTweaker
        palette="warm-charcoal"
        texture="paper"
        onPaletteChange={onPaletteChange}
        onTextureChange={onTextureChange}
        onNotify={onNotify}
        onShowPeople={vi.fn()}
        onShowChat={vi.fn()}
        onShowScreenShare={vi.fn()}
        onShowWhiteboard={vi.fn()}
        onShowMeetingInfo={vi.fn()}
        onShowSettings={vi.fn()}
        onToggleHand={onToggleHand}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    fireEvent.change(screen.getByLabelText("Palette"), { target: { value: "oled-signal" } });
    fireEvent.change(screen.getByLabelText("Texture"), { target: { value: "slate" } });
    fireEvent.click(screen.getByRole("button", { name: "Raised hand" }));
    fireEvent.click(screen.getByRole("button", { name: "warning" }));

    expect(onToggleHand).toHaveBeenCalledOnce();
    expect(onPaletteChange).toHaveBeenCalledWith("oled-signal");
    expect(onTextureChange).toHaveBeenCalledWith("slate");
    expect(onNotify).toHaveBeenCalledWith("warning");
  });
});
