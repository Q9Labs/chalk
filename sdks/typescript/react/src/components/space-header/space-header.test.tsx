// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SpaceHeader } from "./SpaceHeader";
import { SkinProvider } from "../skin-context";

afterEach(cleanup);

describe("SpaceHeader", () => {
  it("renders the header with visible chalk chrome", () => {
    render(<SpaceHeader spaceName="Design review" />);

    expect(screen.getByRole("banner")).toHaveClass("text-[var(--chalk-app-text)]");
    expect(screen.getByRole("banner").querySelector("svg[data-chalk-chrome='true']")).toBeInTheDocument();
  });

  it("opens space information and changes the layout through the menu", () => {
    const onInfo = vi.fn();
    const onLayoutChange = vi.fn();
    render(<SpaceHeader spaceName="Design review" duration={1122} layout="focus" onInfo={onInfo} onLayoutChange={onLayoutChange} />);

    fireEvent.click(screen.getByRole("button", { name: "Space information" }));
    expect(onInfo).toHaveBeenCalledOnce();

    const trigger = screen.getByRole("button", { name: "Layout: Spotlight" });
    fireEvent.mouseDown(trigger);
    fireEvent.click(trigger);
    const menu = screen.getByRole("menu", { name: "Layout: Spotlight" });
    expect(within(menu).getByRole("menuitemradio", { name: /Spotlight/ })).toHaveAttribute("aria-checked", "true");
    fireEvent.click(within(menu).getByRole("menuitemradio", { name: /Grid/ }));
    expect(onLayoutChange).toHaveBeenCalledWith("grid");
  });

  it("uses the Episode duration label and the same visual treatment for header actions", () => {
    render(<SpaceHeader spaceName="Design review" duration={2} onInfo={vi.fn()} onSettings={vi.fn()} />);

    expect(screen.getByLabelText("Episode duration 00:00:02")).toBeInTheDocument();
    const infoButton = screen.getByRole("button", { name: "Space information" });
    const settingsButton = screen.getByRole("button", { name: "Settings" });
    expect(infoButton).toHaveClass("text-[var(--chalk-app-text-muted)]");
    expect(settingsButton).toHaveClass("text-[var(--chalk-app-text-muted)]");
    expect(settingsButton.className).toBe(infoButton.className);
  });

  it("restores the classic header structure without rough chrome", () => {
    render(
      <SkinProvider skin="classic">
        <SpaceHeader spaceName="Design review" />
      </SkinProvider>,
    );

    const header = screen.getByRole("banner");
    expect(header).toHaveClass("relative", "h-14", "text-[var(--chalk-app-text)]");
    expect(header.querySelector("svg[data-chalk-chrome='true']")).not.toBeInTheDocument();
  });
});
