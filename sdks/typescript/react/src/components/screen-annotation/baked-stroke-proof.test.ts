import { describe, expect, it } from "vitest";
import { frameProvesStroke, inkHandoff, makeStrokeProof, type InkRaster } from "./baked-stroke-proof";

// A narrow stroke and its unchanged surroundings; values are straight-alpha pixels.
function raster(background: number, stroke?: { dark: number; bright: number; alpha: number }): InkRaster {
  const width = 12;
  const height = 12;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const ink = y === 6 && x >= 2 && x <= 9;
      const gray = ink && stroke ? stroke.bright : y === 6 && !stroke ? 50 : background;
      const offset = (y * width + x) * 4;
      data.set([gray, ink && stroke ? stroke.dark : gray, gray, ink && stroke ? stroke.alpha : 255], offset);
    }
  }
  return { width, height, data };
}

function stencil(alpha: number): InkRaster {
  const image = raster(0, { dark: 30, bright: 250, alpha });
  for (let i = 3; i < image.data.length; i += 4) if (image.data[i] === 255) image.data[i] = 0;
  return image;
}

function proofFor(alpha = 254) {
  const proof = makeStrokeProof(raster(50), stencil(alpha));
  if (!proof) throw new Error("Fixture has no readable stroke");
  return proof;
}

describe("baked stroke frame evidence", () => {
  it("does not hand off on old frames or if the first qualifying frame dropped", () => {
    const proof = proofFor();
    expect([raster(50), raster(50), raster(53, { dark: 35, bright: 203, alpha: 255 })].map((frame) => frameProvesStroke(frame, proof))).toEqual([false, false, true]);
  });

  it("tracks translucent highlighter as a blend, not a nominal ink color", () => {
    const proof = proofFor(96);
    const transparent = raster(50, { dark: 44, bright: 110, alpha: 255 });
    expect(frameProvesStroke(transparent, proof)).toBe(true);
    expect(frameProvesStroke(raster(50, { dark: 30, bright: 250, alpha: 255 }), proof)).toBe(false);
    expect(frameProvesStroke(raster(50), proof)).toBe(false);
  });

  it("does not qualify unrelated background changes or an incompatible replacement frame", () => {
    const proof = proofFor();
    const strongInk = raster(173, { dark: 37, bright: 208, alpha: 255 });
    expect(frameProvesStroke(strongInk, proof)).toBe(false);
    expect(frameProvesStroke({ ...strongInk, width: 11 }, proof)).toBe(false);
  });

  it("keeps the local copy if matching background supplies no new evidence", () => {
    const sameColor = raster(50, { dark: 30, bright: 250, alpha: 255 });
    expect(makeStrokeProof(sameColor, stencil(254))).toBeNull();
  });
});

describe("own ink paint source", () => {
  const input = {
    baked: true,
    nowMs: 4000,
    revision: 4,
    mark: { expires_at_ms: null },
    preview: { startedBaked: true, expiresAt: 1000, revision: 4 },
    proved: false,
  };

  it("keeps local ink after the receipt, then selects exactly one source for the proving frame", () => {
    const proof = proofFor();
    const frames = [raster(50), raster(50), raster(53, { dark: 35, bright: 203, alpha: 255 })];
    expect(frames.map((frame) => inkHandoff({ ...input, proved: frameProvesStroke(frame, proof) }))).toEqual(["local", "local", "video"]);
  });

  it("does not erase on a receipt ahead of a recovered snapshot", () => {
    expect(inkHandoff({ ...input, mark: undefined, revision: 3 })).toBe("local");
    expect(inkHandoff({ ...input, mark: undefined, revision: 4 })).toBe("removed");
  });

  it("does not resurrect erased, undone or expired ink when a late frame still contains it", () => {
    expect(inkHandoff({ ...input, mark: undefined, revision: 6, proved: true })).toBe("removed");
    expect(inkHandoff({ ...input, mark: { expires_at_ms: 3999 }, proved: true })).toBe("removed");
  });

  it("uses data when baked presentation is no longer active", () => {
    expect(inkHandoff({ ...input, baked: false, proved: true })).toBe("data");
    expect(inkHandoff({ ...input, baked: false, mark: undefined, revision: 3 })).toBe("local");
  });
});
