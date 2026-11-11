import { describe, expect, it } from "vitest";
import { checkInk, strokeChip, strokePreview, strokeTarget } from "./board-model";

describe("stroke chip", () => {
  it("shows the colour disc and a bar at the real width", () => {
    expect(strokeChip("blue", "thick", "chalkboard", "dark")).toEqual({ disc: "#1f7ad6", bar: 8, label: "Colour and width: Blue, thick" });
    expect(strokeChip("red", "thin", "paper", "light").bar).toBe(2.5);
  });

  it("shows Ink as the surface's own ink, so the disc is never invisible", () => {
    expect(strokeChip("ink", "medium", "chalkboard", "dark").disc).toBe("#f1f0ea");
    expect(strokeChip("ink", "medium", "paper", "light").disc).toBe("#1b1c1f");
  });
});

describe("stroke popover", () => {
  it("says which tool the colour and width style", () => {
    expect(strokeTarget("pen")).toBe("Pen");
    expect(strokeTarget("highlighter")).toBe("Highlighter");
    expect(strokeTarget("ellipse")).toBe("Ellipse");
    expect(strokeTarget("note")).toBe("Sticky note");
    expect(strokeTarget("selection")).toBe("Selection");
    expect(strokeTarget("eraser")).toBe("Pen");
  });

  it("previews the pen at its colour and width, and the highlighter wide and see-through", () => {
    expect(strokePreview("pen", "green", "medium", "dots", "dark")).toEqual({ stroke: "#288a51", width: 4.5, opacity: 1 });
    expect(strokePreview("highlighter", "ink", "thin", "dots", "dark")).toEqual({ stroke: "#c15a10", width: 10, opacity: 0.4 });
  });

  it("puts a dark mark in a light colour and a light mark in a dark one", () => {
    expect(checkInk("#f1f0ea")).toBe("#111111");
    expect(checkInk("#1b1c1f")).toBe("#ffffff");
    expect(checkInk("#e23240")).toBe("#ffffff");
  });
});
