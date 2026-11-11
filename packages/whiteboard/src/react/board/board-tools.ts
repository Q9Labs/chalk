import type { BoardGlyph } from "./BoardIcon";
import { SHAPES, type BoardTool } from "./board-model";

export type ToolEntry = { readonly tool: BoardTool; readonly label: string; readonly key: string; readonly glyph: BoardGlyph };

/** The island's groups, left to right. The shapes sit in a flyout after the second group's first pair. */
export const TOOL_GROUPS: readonly (readonly ToolEntry[])[] = [
  [
    { tool: "selection", label: "Select", key: "V", glyph: "select" },
    { tool: "hand", label: "Hand", key: "H", glyph: "hand" },
  ],
  [
    { tool: "pen", label: "Pen", key: "P", glyph: "pen" },
    { tool: "highlighter", label: "Highlighter", key: "U", glyph: "highlighter" },
  ],
  [
    { tool: "text", label: "Text", key: "T", glyph: "text" },
    { tool: "note", label: "Sticky note", key: "N", glyph: "note" },
  ],
  [
    { tool: "eraser", label: "Eraser", key: "E", glyph: "eraser" },
    { tool: "laser", label: "Laser pointer", key: "K", glyph: "laser" },
  ],
];

export const SHAPE_ENTRIES: readonly ToolEntry[] = SHAPES.map((shape) => ({ tool: shape.id, label: shape.label, key: shape.key, glyph: shape.id }));

const byTool = new Map<BoardTool, ToolEntry>([...TOOL_GROUPS.flat(), ...SHAPE_ENTRIES].map((entry) => [entry.tool, entry]));

export function toolEntry(tool: BoardTool): ToolEntry {
  return byTool.get(tool)!;
}

/** The phone's tool tray: every tool with its name, in the order a person reaches for them. */
export const TRAY_COLUMNS = 5;
export const TRAY_TOOLS: readonly ToolEntry[] = [...(["selection", "hand", "pen", "highlighter", "eraser"] as const), ...SHAPES.map((shape) => shape.id), ...(["text", "note", "laser"] as const)].map(toolEntry);
