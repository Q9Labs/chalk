import { describe, expect, it } from "vitest";
import type { BoardTool } from "./board-model";
import { TOOL_GROUPS, TRAY_COLUMNS, TRAY_TOOLS, toolEntry } from "./board-tools";

const EVERY_TOOL: Record<BoardTool, true> = { selection: true, hand: true, pen: true, highlighter: true, rectangle: true, ellipse: true, diamond: true, arrow: true, line: true, text: true, note: true, eraser: true, laser: true };

describe("the phone's tool tray", () => {
  it("offers every tool once, so nothing hides behind a scroll", () => {
    expect(TRAY_TOOLS.map((entry) => entry.tool).toSorted()).toEqual(Object.keys(EVERY_TOOL).toSorted());
  });

  it("names every tool, with the labels the island's own buttons use", () => {
    expect(TRAY_TOOLS.every((entry) => entry.label.length > 0)).toBe(true);
    for (const entry of TOOL_GROUPS.flat()) expect(toolEntry(entry.tool).label).toBe(entry.label);
  });

  it("fills five columns in the design's order, with a short last row", () => {
    expect(TRAY_COLUMNS).toBe(5);
    expect(TRAY_TOOLS.map((entry) => entry.label)).toEqual(["Select", "Hand", "Pen", "Highlighter", "Eraser", "Rectangle", "Ellipse", "Diamond", "Arrow", "Line", "Text", "Sticky note", "Laser pointer"]);
    expect(TRAY_TOOLS.length % TRAY_COLUMNS).toBe(3);
  });
});
