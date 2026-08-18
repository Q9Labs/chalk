// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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

  it("opens space information and keeps layout selection explicit", () => {
    const onInfo = vi.fn();
    const onLayoutChange = vi.fn();
    render(<SpaceHeader spaceName="Design review" duration={1122} layout="focus" onInfo={onInfo} onLayoutChange={onLayoutChange} />);

    fireEvent.click(screen.getByRole("button", { name: "Space information" }));
    fireEvent.click(screen.getByRole("button", { name: "Grid layout" }));
    fireEvent.click(screen.getByRole("button", { name: "Presentation layout" }));

    expect(onInfo).toHaveBeenCalledOnce();
    expect(onLayoutChange).toHaveBeenNthCalledWith(1, "grid");
    expect(onLayoutChange).toHaveBeenNthCalledWith(2, "presentation");
    expect(screen.getByRole("button", { name: "Spotlight layout" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Grid layout" })).toHaveAttribute("aria-pressed", "false");
  });

  it("restores the classic header structure without rough chrome", () => {
    render(
      <SkinProvider skin="classic">
        <SpaceHeader spaceName="Design review" />
      </SkinProvider>,
    );

    const header = screen.getByRole("banner");
    expect(header).toHaveClass("chalk-textured-surface", "border-b", "bg-[var(--chalk-app-chrome)]");
    expect(header.querySelector("svg[data-chalk-chrome='true']")).not.toBeInTheDocument();
  });
});
