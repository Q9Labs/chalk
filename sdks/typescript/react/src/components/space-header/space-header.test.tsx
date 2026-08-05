// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SpaceHeader } from "./SpaceHeader";

afterEach(cleanup);

describe("SpaceHeader", () => {
  it("uses the app appearance tokens for dark palette chrome", () => {
    render(<SpaceHeader spaceName="Design review" />);

    expect(screen.getByRole("banner")).toHaveClass("border-[var(--chalk-app-line)]", "bg-[var(--chalk-app-chrome)]", "text-[var(--chalk-app-text)]");
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
  });
});
