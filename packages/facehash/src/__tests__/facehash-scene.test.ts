import { describe, expect, it } from "vitest";
import { createFacehashScene, getColor } from "../index";

describe("facehash scene", () => {
  it("stays deterministic for the same name", () => {
    expect(createFacehashScene({ name: "Hasan" })).toEqual(createFacehashScene({ name: "Hasan" }));
  });

  it("pins the upstream face projection contract", () => {
    expect(createFacehashScene({ name: "Hasan" })).toMatchObject({
      data: {
        colorIndex: 1,
        faceType: "curved",
        initial: "H",
        rotation: { x: 0, y: 0 },
      },
      gradientCenter: { x: 50, y: 50 },
      projection: {
        cssTransform: "translate(0%, 0%) skew(0deg, 0deg) scale(1, 1)",
        svgTransform: "translate(0 0) translate(50 50) skewX(0) skewY(0) scale(1 1) translate(-50 -50)",
      },
    });
  });

  it("uses the seeded pose for non-front-facing names", () => {
    expect(createFacehashScene({ name: "Yahya" })).toMatchObject({
      data: {
        colorIndex: 3,
        faceType: "round",
        initial: "Y",
        rotation: { x: -1, y: -1 },
      },
      gradientCenter: { x: 56, y: 44 },
      projection: {
        cssTransform: "translate(-5%, 5%) skew(3.5deg, -1.75deg) scale(0.92, 0.92)",
      },
    });
  });

  it("falls back to the default palette safely", () => {
    expect(getColor([], 7)).toBe("#3b82f6");
  });
});
