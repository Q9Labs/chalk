// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useRef, useState } from "react";

import { LayoutMenu, LAYOUT_OPTIONS, type StageLayoutValue } from "./LayoutMenu";

afterEach(cleanup);

function LayoutMenuHarness({ layout, onLayoutChange }: { readonly layout: StageLayoutValue; readonly onLayoutChange: (layout: StageLayoutValue) => void }) {
  const container = useRef<HTMLDivElement>(null);
  return (
    <div ref={container}>
      <LayoutMenu layout={layout} onLayoutChange={onLayoutChange} container={container} skin="chalk" />
    </div>
  );
}

function StatefulLayoutMenuHarness() {
  const container = useRef<HTMLDivElement>(null);
  const [layout, setLayout] = useState<StageLayoutValue>("focus");
  return (
    <div ref={container}>
      <LayoutMenu layout={layout} onLayoutChange={setLayout} container={container} skin="chalk" />
    </div>
  );
}

describe("LayoutMenu", () => {
  it("lists every supported layout and marks the current layout", () => {
    render(<LayoutMenuHarness layout="grid" onLayoutChange={vi.fn()} />);

    const trigger = screen.getByRole("button", { name: "Layout: Grid" });
    fireEvent.mouseDown(trigger);
    fireEvent.click(trigger);

    const menu = screen.getByRole("menu", { name: "Layout: Grid" });
    expect(menu).toHaveClass("w-[320px]", "max-w-[calc(100vw-24px)]");
    expect(within(menu).getAllByRole("menuitemradio")).toHaveLength(LAYOUT_OPTIONS.length);
    expect(within(menu).getByRole("menuitemradio", { name: /Grid/ })).toHaveAttribute("aria-checked", "true");
    expect(within(menu).getByText("Shared content with people alongside")).toBeInTheDocument();
  });

  it("keeps every description the same length so selecting a layout cannot resize the menu", () => {
    expect(new Set(LAYOUT_OPTIONS.map(({ description }) => description.length))).toEqual(new Set([36]));
  });

  it("forwards a supported selection to the host", () => {
    const onLayoutChange = vi.fn();
    render(<LayoutMenuHarness layout="focus" onLayoutChange={onLayoutChange} />);

    const trigger = screen.getByRole("button", { name: "Layout: Spotlight" });
    fireEvent.mouseDown(trigger);
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("menuitemradio", { name: /Presentation/ }));

    expect(onLayoutChange).toHaveBeenCalledWith("presentation");
  });

  it("keeps the chooser open and moves its selection surface in menu order", () => {
    render(<StatefulLayoutMenuHarness />);

    const trigger = screen.getByRole("button", { name: "Layout: Spotlight" });
    fireEvent.mouseDown(trigger);
    fireEvent.click(trigger);

    fireEvent.click(screen.getByRole("menuitemradio", { name: /Presentation/ }));
    expect(screen.getByRole("menu", { name: "Layout: Presentation" })).toBeInTheDocument();
    expect(screen.getByTestId("layout-selection")).toHaveStyle({ transform: "translate3d(0, 108px, 0)" });

    fireEvent.click(screen.getByRole("menuitemradio", { name: /Spotlight/ }));
    expect(screen.getByTestId("layout-selection")).toHaveStyle({ transform: "translate3d(0, 0px, 0)" });
  });
});
