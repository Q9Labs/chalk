import { describe, expect, it } from "vitest";
import { NATIVE_INK_PROOF_TIMEOUT_MS, frameProvesStroke, inkHandoff, makeStrokeProof, type InkRaster } from "../src/baked-stroke-proof";

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

function shiftRows(image: InkRaster, rows: number): InkRaster {
  const data = new Uint8ClampedArray(image.data.length);
  data.set(image.data.subarray(0, image.data.length - rows * image.width * 4), rows * image.width * 4);
  return { ...image, data };
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

  it("hands off on a one-pixel raster shift, but not on pre-existing nearby ink", () => {
    const frame = shiftRows(raster(50, { dark: 35, bright: 203, alpha: 255 }), 1);
    expect(frameProvesStroke(frame, proofFor())).toBe(true);
    expect(frameProvesStroke(shiftRows(frame, 1), proofFor())).toBe(false);

    const proof = makeStrokeProof(frame, stencil(254));
    if (!proof) throw new Error("Fixture has no readable stroke");
    expect(frameProvesStroke(frame, proof)).toBe(false);
  });

  it("proves the decoded body of an antialiased pen even when its faint edge disappears", () => {
    // The RGBA rows are the local stencil and WebRTC-decoded samples of the
    // same thin pen stroke over black; the decoder shifted its strongest row.
    const baseline = raster(0, { dark: 0, bright: 0, alpha: 255 });
    const ink = stencil(254);
    const frame = { ...baseline, data: baseline.data.slice() };
    for (let x = 2; x <= 9; x++) {
      ink.data.set([215, 64, 135, 64], (5 * ink.width + x) * 4);
      ink.data.set([215, 66, 134, 255], (6 * ink.width + x) * 4);
      ink.data.set([215, 66, 133, 128], (7 * ink.width + x) * 4);
      frame.data.set([0, 0, 2, 255], (5 * frame.width + x) * 4);
      frame.data.set([86, 36, 52, 255], (6 * frame.width + x) * 4);
      frame.data.set([166, 55, 99, 255], (7 * frame.width + x) * 4);
    }
    const proof = makeStrokeProof(baseline, ink);
    if (!proof) throw new Error("Fixture has no readable stroke");
    expect(frameProvesStroke(baseline, proof)).toBe(false);
    expect(frameProvesStroke(frame, proof)).toBe(true);
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

  it("bounds native ink when pixels never supply proof without using a receipt as proof", () => {
    const deadline = input.nowMs + NATIVE_INK_PROOF_TIMEOUT_MS;
    const preview = { ...input.preview, proofTimeoutAt: deadline };
    expect(inkHandoff({ ...input, preview, nowMs: deadline - 1 })).toBe("local");
    expect(inkHandoff({ ...input, preview, nowMs: deadline })).toBe("removed");
    expect(inkHandoff({ ...input, preview, nowMs: deadline - 1, proved: true })).toBe("video");
  });

  it("uses data when baked presentation is no longer active", () => {
    expect(inkHandoff({ ...input, baked: false, proved: true })).toBe("data");
    expect(inkHandoff({ ...input, baked: false, mark: undefined, revision: 3 })).toBe("local");
  });
});
