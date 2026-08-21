// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SkinProvider } from "../skin-context";
import { ReactionTray } from "./ReactionTray";

afterEach(cleanup);

describe("ReactionTray", () => {
  it("selects the reaction that the participant clicks", () => {
    const onSelect = vi.fn();

    render(<ReactionTray reactions={["👍", "🎉"]} onSelect={onSelect} onClose={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "React with 🎉" }));

    expect(onSelect).toHaveBeenCalledOnce();
    expect(onSelect).toHaveBeenCalledWith("🎉");
  });

  it("focuses the first reaction, supports keyboard navigation, and closes on Escape", () => {
    const onClose = vi.fn();

    render(<ReactionTray reactions={["👍", "🎉", "❤️"]} onSelect={vi.fn()} onClose={onClose} />);

    const buttons = screen.getAllByRole("button");
    expect(buttons[0]).toHaveFocus();

    fireEvent.keyDown(buttons[0], { key: "ArrowRight" });
    expect(buttons[1]).toHaveFocus();

    fireEvent.keyDown(buttons[1], { key: "End" });
    expect(buttons[2]).toHaveFocus();

    fireEvent.keyDown(buttons[2], { key: "ArrowRight" });
    expect(buttons[0]).toHaveFocus();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("uses palette-aware classic panel tokens and leaves the control bar clickable", () => {
    const onClose = vi.fn();
    const { container } = render(
      <SkinProvider skin="classic">
        <ReactionTray reactions={["👍", "❤️"]} onSelect={vi.fn()} onClose={onClose} />
      </SkinProvider>,
    );

    expect(screen.getByRole("toolbar", { name: "Reactions" })).toHaveClass("bg-[var(--chalk-app-panel)]", "ring-[var(--chalk-app-line)]");
    const backdrop = container.querySelector<HTMLElement>("[aria-hidden='true']");
    expect(backdrop).toHaveClass("z-20");

    fireEvent.click(backdrop!);
    expect(onClose).toHaveBeenCalledOnce();
  });
});
