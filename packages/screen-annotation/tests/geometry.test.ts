import { describe, expect, it } from "vitest";

import { clampedFramePoint, contentRect, framePoint, projectFramePoint, simplifyStroke } from "../src/index";

describe("frame geometry", () => {
  it("maps the visible fit content, not padding or device pixels", () => {
    const viewport = { x: -197, y: 33, width: 810, height: 630 };
    const rect = contentRect({ width: 1920, height: 1080 }, viewport, "fit");
    expect(rect).toEqual({ x: -197, y: 120.1875, width: 810, height: 455.625 });
    if (!rect) throw new Error("No content");
    expect(framePoint(rect, { x: -190, y: 50 })).toBeNull();
    expect(clampedFramePoint(rect, { x: -350, y: 900 })).toEqual({ x: 0, y: 65535 });
    expect(contentRect({ width: 0, height: 1080 }, viewport, "fit")).toBeNull();
  });

  it.each([
    [1920, 1080, "fit", 1],
    [1080, 1920, "fit", 2],
    [3840, 2160, "fill", 1.25],
    [720, 1280, "fill", 3],
  ] as const)("aligns asymmetric fiducials for %sx%s %s at %sx DPI", (width, height, fit, dpi) => {
    const viewport = { x: -711.5, y: 73.3, width: 920, height: 645 };
    const rect = contentRect({ width, height }, viewport, fit);
    if (!rect) throw new Error("No content");
    const scale = fit === "fit" ? Math.min(viewport.width / width, viewport.height / height) : Math.max(viewport.width / width, viewport.height / height);
    for (const [u, v] of [
      [0.31, 0.4],
      [0.46, 0.59],
      [0.67, 0.56],
    ]) {
      if (u === undefined || v === undefined) throw new Error("Malformed fiducial");
      const point = { x: viewport.x + viewport.width / 2 + (u - 0.5) * width * scale, y: viewport.y + viewport.height / 2 + (v - 0.5) * height * scale };
      const wire = framePoint(rect, point);
      if (!wire) throw new Error("No point");
      const painted = projectFramePoint(rect, wire);
      const deviceError = Math.hypot(Math.round(painted.x * dpi) - point.x * dpi, Math.round(painted.y * dpi) - point.y * dpi);
      expect(deviceError / (rect.width * dpi)).toBeLessThan(0.005);
    }
  });

  it("bounds strokes while preserving endpoints, order and an isolated extreme", () => {
    const input = Array.from({ length: 920 }, (_, x) => ({ x, y: x === 389 ? 20000 : (x % 2) * 120 }));
    const reduced = simplifyStroke(input, 0);
    expect(reduced).toHaveLength(384);
    expect(reduced).toContain(input[389]);
    expect(reduced[0]).toBe(input[0]);
    expect(reduced.at(-1)).toBe(input.at(-1));
    expect(reduced.map((point) => point.x)).toEqual(reduced.map((point) => point.x).sort((a, b) => a - b));
    expect(
      simplifyStroke([
        { x: 5, y: 5 },
        { x: 5, y: 5 },
      ]),
    ).toEqual([{ x: 5, y: 5 }]);
  });
});
