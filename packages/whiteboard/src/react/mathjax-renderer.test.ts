import { describe, expect, it } from "vitest";

import { getRenderedSvgSize } from "./mathjax-renderer";

describe("mathjaxRenderer", () => {
  it("derives dimensions from SVG width and height attributes", () => {
    expect(getRenderedSvgSize('<svg width="10ex" height="4ex" viewBox="0 0 100 40"></svg>')).toEqual({
      width: 104,
      height: 56,
    });
  });

  it("falls back to default dimensions when SVG size is unavailable", () => {
    expect(getRenderedSvgSize("<svg></svg>")).toEqual({ width: 240, height: 96 });
  });
});
