import { describe, expect, it } from "vitest";
import type { BoardTool } from "./board-model";
import { TOOL_GROUPS, TRAY_TOOLS, toolEntry } from "./board-tools";

const EVERY_TOOL: Record<BoardTool, true> = { selection: true, hand: true, pen: true, highlighter: true, rectangle: true, ellipse: true, diamond: true, arrow: true, line: true, text: true, note: true, eraser: true, laser: true };

describe("the phone's tool tray", () => {
  it("offers every tool once, so nothing hides behind a scroll", () => {
    expect(TRAY_TOOLS.map((entry) => entry.tool).toSorted()).toEqual(Object.keys(EVERY_TOOL).toSorted());
  });

  it("labels every tool the way the island's own buttons do", () => {
    for (const entry of TOOL_GROUPS.flat()) expect(toolEntry(entry.tool).label).toBe(entry.label);
  });
});
