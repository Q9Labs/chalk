// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { calculateVirtualWindow, VirtualRows } from "./VirtualRows";

afterEach(cleanup);

describe("calculateVirtualWindow", () => {
  it("bounds the rendered range instead of loading the complete ledger", () => {
    expect(calculateVirtualWindow(1_000_000, 40, 400, 20_000, 3)).toEqual({
      start: 497,
      end: 513,
      offset: 19_880,
      totalHeight: 40_000_000,
    });
  });
});

describe("VirtualRows", () => {
  it("keeps keyboard focus on the grid while virtual rows change", () => {
    const onSelect = vi.fn();
    const items = Array.from({ length: 200 }, (_, index) => ({ id: `op-${index}` }));
    render(<VirtualRows items={items} getKey={(item) => item.id} label="Diagnostic operations" renderRow={(item) => item.id} onSelect={onSelect} rowHeight={40} viewportHeight={160} />);
    const grid = screen.getByRole("grid", { name: "Diagnostic operations" });
    grid.focus();

    fireEvent.keyDown(grid, { key: "End" });

    expect(document.activeElement).toBe(grid);
    expect(onSelect).toHaveBeenCalledWith(items[199]);
    expect(grid.getAttribute("aria-activedescendant")).toBe("virtual-row-op-199");
  });
});
