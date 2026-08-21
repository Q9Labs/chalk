import { describe, expect, it } from "vitest";

import { bestArrangement, DEFAULT_GRID_OPTIONS, DEFAULT_SPOTLIGHT_OPTIONS, fitGrid, fitSpotlight, tilesPerPage, WIDESCREEN, type StageBox, type StageFrame } from "./stage-layout";

const ids = (count: number) => Array.from({ length: count }, (_, index) => `p${index + 1}`);
const gridOptions = DEFAULT_GRID_OPTIONS;
const desktop: StageBox = { width: 1200, height: 675 };
const wide: StageBox = { width: 1600, height: 600 };
const phone: StageBox = { width: 360, height: 640 };

const overlaps = (a: StageFrame, b: StageFrame) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
const coverage = (box: StageBox, frames: readonly StageFrame[]) => frames.reduce((total, frame) => total + frame.width * frame.height, 0) / (box.width * box.height);

describe("bestArrangement", () => {
  it("fills the box with equal cells for four tiles", () => {
    const arrangement = bestArrangement(desktop, 4, gridOptions);
    expect(arrangement.cols).toBe(2);
    expect(arrangement.rows).toBe(2);
    expect(arrangement.tileWidth).toBeCloseTo((desktop.width - 12) / 2, 5);
    expect(arrangement.tileHeight).toBeCloseTo((desktop.height - 12) / 2, 5);
  });

  it("stacks two tiles on a phone and lets them fill the width", () => {
    const arrangement = bestArrangement(phone, 2, gridOptions);
    expect(arrangement.cols).toBe(1);
    expect(arrangement.tileWidth).toBe(phone.width);
    expect(arrangement.tileHeight).toBeCloseTo((phone.height - 12) / 2, 5);
  });

  it("clamps a single tile in a very wide cell to the aspect bounds", () => {
    const arrangement = bestArrangement({ width: 3000, height: 400 }, 1, gridOptions);
    expect(arrangement.tileHeight).toBe(400);
    expect(arrangement.tileWidth).toBeCloseTo(400 * gridOptions.maxAspect, 5);
  });

  it("prefers an arrangement that fills its cells over a clamped one of similar area", () => {
    // 3 across in 16:9 would clamp to 3:4 (392x523 = 205k); 2+1 fills its cells (594x331 = 197k).
    const arrangement = bestArrangement(desktop, 3, gridOptions);
    expect(arrangement.cols).toBe(2);
    expect(arrangement.rows).toBe(2);
  });
});

describe("fitGrid", () => {
  it("returns no frames for an empty stage", () => {
    expect(fitGrid(desktop, [], gridOptions)).toEqual({ frames: [], pageCount: 0, perPage: 0 });
  });

  it("fills the whole box for a single tile", () => {
    const { frames, pageCount } = fitGrid(desktop, ["solo"], gridOptions);
    expect(pageCount).toBe(1);
    expect(frames).toEqual([{ id: "solo", role: "grid", page: 0, x: 0, y: 0, width: 1200, height: 675 }]);
  });

  it.each([2, 3, 4, 5, 6, 7, 9, 12, 16, 20, 25])("lays out %i tiles inside the box without overlap and within the aspect bounds", (count) => {
    const { frames, pageCount } = fitGrid(desktop, ids(count), gridOptions);
    expect(pageCount).toBe(1);
    expect(frames).toHaveLength(count);
    for (const frame of frames) {
      expect(frame.x).toBeGreaterThanOrEqual(0);
      expect(frame.y).toBeGreaterThanOrEqual(0);
      expect(frame.x + frame.width).toBeLessThanOrEqual(desktop.width + 0.01);
      expect(frame.y + frame.height).toBeLessThanOrEqual(desktop.height + 0.01);
      expect(frame.width / frame.height).toBeGreaterThanOrEqual(gridOptions.minAspect - 0.01);
      expect(frame.width / frame.height).toBeLessThanOrEqual(gridOptions.maxAspect + 0.01);
    }
    for (let a = 0; a < frames.length; a += 1) for (let b = a + 1; b < frames.length; b += 1) expect(overlaps(frames[a]!, frames[b]!)).toBe(false);
  });

  it.each([2, 4, 6, 9, 12, 16])("covers the box with %i tiles apart from the gaps", (count) => {
    const { frames } = fitGrid(desktop, ids(count), gridOptions);
    expect(coverage(desktop, frames)).toBeGreaterThan(0.9);
    expect(Math.min(...frames.map((frame) => frame.x))).toBe(0);
    expect(Math.min(...frames.map((frame) => frame.y))).toBe(0);
    expect(Math.max(...frames.map((frame) => frame.x + frame.width))).toBeCloseTo(desktop.width, 0);
    expect(Math.max(...frames.map((frame) => frame.y + frame.height))).toBeCloseTo(desktop.height, 0);
  });

  it("gives every tile on a page the same size and centres the last row", () => {
    const { frames } = fitGrid(desktop, ids(5), gridOptions);
    const sizes = new Set(frames.map((frame) => `${frame.width}x${frame.height}`));
    expect(sizes.size).toBe(1);
    const lastRow = frames.filter((frame) => frame.y === Math.max(...frames.map((f) => f.y)));
    expect(lastRow).toHaveLength(2);
    const rowStart = Math.min(...lastRow.map((f) => f.x));
    const rowEnd = Math.max(...lastRow.map((f) => f.x + f.width));
    expect(rowStart).toBeCloseTo(desktop.width - rowEnd, 0);
  });

  it("centres clamped tiles inside a very wide box", () => {
    const veryWide: StageBox = { width: 3200, height: 500 };
    const { frames } = fitGrid(veryWide, ids(2), gridOptions);
    const first = frames[0]!;
    const last = frames[1]!;
    expect(first.height).toBe(veryWide.height);
    expect(first.width / first.height).toBeCloseTo(gridOptions.maxAspect, 3);
    expect(first.x).toBeCloseTo(veryWide.width - (last.x + last.width), 0);
  });

  it("fills a wide box edge to edge with two tiles", () => {
    const { frames } = fitGrid(wide, ids(2), gridOptions);
    expect(frames[0]!.x).toBe(0);
    expect(frames[0]!.y).toBe(0);
    expect(frames[1]!.x + frames[1]!.width).toBeCloseTo(wide.width, 0);
    expect(frames[1]!.height).toBe(wide.height);
  });

  it("pages when tiles would drop below the minimum width and keeps page tiles equal", () => {
    const options = { ...gridOptions, maxPerPage: 100 };
    const geometry = fitGrid(desktop, ids(60), options);
    expect(geometry.pageCount).toBeGreaterThan(1);
    expect(geometry.frames.every((frame) => frame.width >= options.minTileWidth && frame.height >= options.minTileHeight)).toBe(true);
    const page0 = geometry.frames.filter((frame) => frame.page === 0);
    const page1 = geometry.frames.filter((frame) => frame.page === 1);
    expect(page0[0]!.width).toBe(page1[0]!.width);
    expect(page1[0]!.x).toBeGreaterThanOrEqual(desktop.width);
    expect(page0.length).toBe(geometry.perPage);
  });

  it("caps pages at maxPerPage", () => {
    const geometry = fitGrid(desktop, ids(26), gridOptions);
    expect(geometry.perPage).toBe(25);
    expect(geometry.pageCount).toBe(2);
    expect(geometry.frames.filter((frame) => frame.page === 1)).toHaveLength(1);
  });

  it("uses fewer tiles per page on a phone so none get shorter than the minimum height", () => {
    const options = { ...gridOptions, minTileWidth: 140 };
    expect(tilesPerPage(phone, 16, options)).toBeLessThan(16);
    const geometry = fitGrid(phone, ids(16), options);
    expect(geometry.pageCount).toBeGreaterThan(1);
    expect(geometry.frames.every((frame) => frame.width >= 140 && frame.height >= options.minTileHeight)).toBe(true);
    expect(geometry.frames.every((frame) => frame.width / frame.height <= options.maxAspect + 0.01)).toBe(true);
  });

  it("stacks two tiles on a phone", () => {
    const { frames } = fitGrid(phone, ids(2), gridOptions);
    expect(frames[0]!.x).toBe(frames[1]!.x);
    expect(frames[0]!.y).toBeLessThan(frames[1]!.y);
  });
});

describe("fitSpotlight", () => {
  it("lets the primary fill the box when nothing is in the strip", () => {
    const { frames, pageCount, perPage } = fitSpotlight(desktop, "solo", [], DEFAULT_SPOTLIGHT_OPTIONS);
    expect(frames).toEqual([{ id: "solo", role: "primary", page: 0, x: 0, y: 0, width: 1200, height: 675 }]);
    expect(pageCount).toBe(1);
    expect(perPage).toBe(0);
  });

  it("places widescreen strip tiles under the primary and centres them", () => {
    const { frames } = fitSpotlight(desktop, "main", ids(3), DEFAULT_SPOTLIGHT_OPTIONS);
    const primary = frames.find((frame) => frame.role === "primary")!;
    const strip = frames.filter((frame) => frame.role === "strip");
    expect(strip).toHaveLength(3);
    const stripHeight = Math.min(168, Math.max(88, 675 * 0.18));
    expect(strip[0]!.height).toBeCloseTo(stripHeight, 1);
    expect(strip[0]!.width / strip[0]!.height).toBeCloseTo(WIDESCREEN, 3);
    expect(strip[0]!.y).toBeCloseTo(primary.height + 12, 1);
    expect(primary.height + 12 + stripHeight).toBeCloseTo(desktop.height, 1);
    const stripStart = Math.min(...strip.map((f) => f.x));
    const stripEnd = Math.max(...strip.map((f) => f.x + f.width));
    expect(stripStart).toBeCloseTo(desktop.width - stripEnd, 0);
  });

  it("pages the strip when it overflows the width", () => {
    const geometry = fitSpotlight(desktop, "main", ids(20), DEFAULT_SPOTLIGHT_OPTIONS);
    expect(geometry.pageCount).toBeGreaterThan(1);
    const strip = geometry.frames.filter((frame) => frame.role === "strip");
    expect(strip.filter((frame) => frame.page === 0)).toHaveLength(geometry.perPage);
    for (const frame of strip.filter((f) => f.page === 0)) expect(frame.x + frame.width).toBeLessThanOrEqual(desktop.width + 0.01);
    for (const frame of strip.filter((f) => f.page === 1)) expect(frame.x).toBeGreaterThanOrEqual(desktop.width);
  });

  it("keeps a strip on a phone", () => {
    const { frames, perPage } = fitSpotlight(phone, "main", ids(4), DEFAULT_SPOTLIGHT_OPTIONS);
    const primary = frames.find((frame) => frame.role === "primary")!;
    expect(primary.width).toBe(phone.width);
    expect(perPage).toBeGreaterThanOrEqual(1);
    expect(frames.filter((frame) => frame.role === "strip" && frame.page === 0).length).toBe(perPage);
  });
});
