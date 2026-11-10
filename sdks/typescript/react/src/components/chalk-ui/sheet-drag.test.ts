import { expect, it } from "vitest";
import { releaseSpeed, sheetOffset, shouldDismiss } from "./sheet-drag";

it("follows the finger down one to one and moves a third as far up", () => {
  expect(sheetOffset(120)).toBe(120);
  expect(sheetOffset(-100)).toBeCloseTo(-30);
});

it("closes past 30% of the sheet height and springs back at or under it", () => {
  expect(shouldDismiss(96, 479, 0)).toBe(false);
  expect(shouldDismiss(143.7, 479, 0)).toBe(false);
  expect(shouldDismiss(143.8, 479, 0)).toBe(true);
  expect(shouldDismiss(210, 479, 0)).toBe(true);
});

it("closes on a flick faster than 0.5 px/ms even from a short drag", () => {
  expect(shouldDismiss(30, 479, 0.5)).toBe(false);
  expect(shouldDismiss(30, 479, 0.51)).toBe(true);
  expect(shouldDismiss(30, 479, -2)).toBe(false);
});

it("measures release speed over the last 100 ms only", () => {
  const slowThenFast = [
    { time: 0, y: 0 },
    { time: 400, y: 20 },
    { time: 450, y: 40 },
    { time: 500, y: 80 },
  ];
  expect(releaseSpeed(slowThenFast)).toBeCloseTo(0.6);
  expect(releaseSpeed([{ time: 0, y: 0 }])).toBe(0);
  expect(releaseSpeed([])).toBe(0);
  expect(
    releaseSpeed([
      { time: 5, y: 0 },
      { time: 5, y: 50 },
    ]),
  ).toBe(0);
});
