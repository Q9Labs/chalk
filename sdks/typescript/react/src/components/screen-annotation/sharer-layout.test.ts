import { expect, it } from "vitest";
import { defaultSharerLayout, layoutAfterArrow, layoutAtPoint, parseSharerLayout } from "./sharer-layout";

const box = { left: 100, top: 50, width: 800, height: 400 };

it("falls back to the default for missing or damaged storage", () => {
  expect(parseSharerLayout(null)).toEqual(defaultSharerLayout);
  expect(parseSharerLayout("not json")).toEqual(defaultSharerLayout);
  expect(parseSharerLayout(JSON.stringify({ look: "pill", edge: "diagonal", offset: 9 }))).toEqual({ look: "pill", edge: "top", offset: 1 });
});

it("keeps a saved layout", () => {
  const saved = { look: "pill", edge: "right", offset: 0.25 } as const;
  expect(parseSharerLayout(JSON.stringify(saved))).toEqual(saved);
});

it("snaps a drag to the nearest edge and keeps the position along it", () => {
  expect(layoutAtPoint(defaultSharerLayout, { x: 500, y: 60 }, box)).toMatchObject({ edge: "top", offset: 0.5 });
  expect(layoutAtPoint(defaultSharerLayout, { x: 890, y: 250 }, box)).toMatchObject({ edge: "right", offset: 0.5 });
  expect(layoutAtPoint(defaultSharerLayout, { x: 500, y: 445 }, box)).toMatchObject({ edge: "bottom" });
});

it("slides along the edge and moves to another edge with the arrow keys", () => {
  expect(layoutAfterArrow(defaultSharerLayout, "ArrowRight").offset).toBeCloseTo(0.6);
  expect(layoutAfterArrow({ ...defaultSharerLayout, offset: 1 }, "ArrowRight").offset).toBe(1);
  expect(layoutAfterArrow(defaultSharerLayout, "ArrowDown").edge).toBe("bottom");
  expect(layoutAfterArrow({ ...defaultSharerLayout, edge: "left" }, "ArrowDown").offset).toBeCloseTo(0.6);
});
