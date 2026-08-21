// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SpaceDrawer } from "./SpaceDrawer";

afterEach(cleanup);

describe("SpaceDrawer", () => {
  it("does not mount anything while closed", () => {
    render(
      <SpaceDrawer state="closed" onClose={vi.fn()}>
        <p>Chat panel</p>
      </SpaceDrawer>,
    );

    expect(screen.queryByText("Chat panel")).not.toBeInTheDocument();
    expect(document.querySelector("[data-chalk-drawer]")).not.toBeInTheDocument();
  });

  it("focuses the drawer, closes on Escape, and restores focus when closing", () => {
    const onClose = vi.fn();
    const view = render(
      <div>
        <button type="button">Open panel</button>
        <SpaceDrawer state="closed" onClose={onClose}>
          <p>Chat panel</p>
        </SpaceDrawer>
      </div>,
    );

    const opener = screen.getByRole("button", { name: "Open panel" });
    opener.focus();
    view.rerender(
      <div>
        <button type="button">Open panel</button>
        <SpaceDrawer state="open" onClose={onClose}>
          <p>Chat panel</p>
        </SpaceDrawer>
      </div>,
    );

    const drawer = document.querySelector<HTMLElement>("[data-chalk-drawer]");
    expect(drawer).toHaveFocus();
    fireEvent.keyDown(drawer!, { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();

    view.rerender(
      <div>
        <button type="button">Open panel</button>
        <SpaceDrawer state="closing" onClose={onClose}>
          <p>Chat panel</p>
        </SpaceDrawer>
      </div>,
    );

    expect(screen.getByRole("button", { name: "Open panel" })).toHaveFocus();
  });
});
