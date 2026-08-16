// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Entrance } from "./Entrance";
import { COSMIC_CHALK_THEME } from "../../theme";

afterEach(cleanup);

describe("Entrance", () => {
  it("offers an optional Back or Cancel action for standalone arrival flows", () => {
    const onCancel = vi.fn();
    const onJoin = vi.fn();
    const view = render(<Entrance spaceName="Design review" defaultDisplayName="Ada" onJoin={onJoin} onCancel={onCancel} />);

    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(onCancel).toHaveBeenCalledOnce();

    view.rerender(<Entrance spaceName="Design review" defaultDisplayName="Ada" joining onJoin={onJoin} onCancel={onCancel} />);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledTimes(2);

    view.rerender(<Entrance spaceName="Design review" defaultDisplayName="Ada" onJoin={onJoin} />);
    expect(screen.queryByRole("button", { name: /Back|Cancel/u })).not.toBeInTheDocument();
  });

  it("applies a supplied palette, texture, and inline token set to the arrival root", () => {
    render(<Entrance spaceName="Design review" defaultDisplayName="Ada" theme={COSMIC_CHALK_THEME} onJoin={() => undefined} />);

    const root = screen.getByRole("main");
    expect(root).toHaveAttribute("data-chalk-theme", "dark");
    expect(root).toHaveAttribute("data-chalk-palette", "cosmic-chalk");
    expect(root).toHaveAttribute("data-chalk-texture", "slate");
    expect(root).toHaveStyle({ "--chalk-canvas": "#080f20", "--chalk-accent": "#8fdcff" });
  });
});
