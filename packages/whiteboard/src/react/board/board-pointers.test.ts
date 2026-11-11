import { describe, expect, it } from "vitest";
import { edgePointer, tagFlip, tagVisible, toScreen } from "./board-pointers";

const viewport = { width: 800, height: 600 };
const tag = { width: 90, height: 28 };
const insets = { top: 56, right: 64, bottom: 80, left: 64 };

describe("name tag flip", () => {
  it("keeps the tag right of the arrow while it fits", () => {
    expect(tagFlip({ x: 300, y: 200 }, tag, viewport)).toEqual({ x: false, y: false });
  });

  it("swings the tag left of the arrow at the right edge and above it at the bottom edge", () => {
    expect(tagFlip({ x: 760, y: 200 }, tag, viewport)).toEqual({ x: true, y: false });
    expect(tagFlip({ x: 300, y: 590 }, tag, viewport)).toEqual({ x: false, y: true });
    expect(tagFlip({ x: 760, y: 590 }, tag, viewport)).toEqual({ x: true, y: true });
  });

  it("stays on the right when the left has even less room, as on a board narrower than the tag", () => {
    expect(tagFlip({ x: 20, y: 200 }, tag, { width: 100, height: 600 })).toEqual({ x: false, y: false });
  });

  it("leaves a tag that only just fits where it is", () => {
    expect(tagFlip({ x: viewport.width - 12 - tag.width, y: 200 }, tag, viewport).x).toBe(false);
    expect(tagFlip({ x: viewport.width - 11 - tag.width, y: 200 }, tag, viewport).x).toBe(true);
  });
});

describe("name tag visibility", () => {
  it("holds the tag while the cursor is recent, past the old 700 ms, and drops it once it is not", () => {
    expect(tagVisible(0, false)).toBe(true);
    expect(tagVisible(3000, false)).toBe(true);
    expect(tagVisible(4000, false)).toBe(false);
  });

  it("shows the tag of a cursor the person points near, however old", () => {
    expect(tagVisible(9000, true)).toBe(true);
  });
});

describe("off-screen pointer chip", () => {
  it("is absent for a cursor in view, edges included", () => {
    expect(edgePointer({ x: 400, y: 300 }, viewport, insets)).toBeNull();
    expect(edgePointer({ x: 0, y: 600 }, viewport, insets)).toBeNull();
  });

  it("sits on the right edge at the cursor's height, pointing right", () => {
    expect(edgePointer({ x: 1040, y: 330 }, viewport, insets)).toEqual({ edge: "right", x: 792, y: 330, angle: 0 });
  });

  it("slides along the edge but stays clear of the board's corners", () => {
    expect(edgePointer({ x: 1040, y: 20 }, viewport, insets)).toMatchObject({ edge: "right", y: 56 });
    expect(edgePointer({ x: -300, y: 590 }, viewport, insets)).toMatchObject({ edge: "left", x: 8, y: 520 });
  });

  it("uses the edge the cursor is furthest past, and turns towards it", () => {
    const above = edgePointer({ x: 380, y: -200 }, viewport, insets);
    expect(above).toMatchObject({ edge: "top", x: 380, y: 56 });
    expect(above?.angle).toBeCloseTo(-90, 5);
    const diagonal = edgePointer({ x: 900, y: 900 }, viewport, insets);
    expect(diagonal).toMatchObject({ edge: "bottom", x: 736, y: 520 });
    expect(diagonal!.angle).toBeGreaterThan(45);
  });

  it("follows the camera: panning or zooming a cursor past an edge puts its chip there", () => {
    const cursor = { x: 500, y: 300 };
    expect(edgePointer(toScreen({ scrollX: 0, scrollY: 0, zoom: 1 }, cursor), viewport, insets)).toBeNull();
    expect(toScreen({ scrollX: 400, scrollY: 0, zoom: 1 }, cursor)).toEqual({ x: 900, y: 300 });
    expect(edgePointer(toScreen({ scrollX: 400, scrollY: 0, zoom: 1 }, cursor), viewport, insets)).toMatchObject({ edge: "right", y: 300 });
    expect(edgePointer(toScreen({ scrollX: 0, scrollY: 0, zoom: 2 }, cursor), viewport, insets)).toMatchObject({ edge: "right", y: 520 });
  });
});
