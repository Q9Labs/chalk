import { fileURLToPath } from "node:url";
import { createCanvas, GlobalFonts } from "@napi-rs/canvas";
import type { ScreenAnnotationMark, ScreenAnnotationPoint, ScreenAnnotationPresence, ScreenAnnotationShape } from "@q9labsai/chalk-client";
import { beforeAll, describe, expect, it } from "vitest";

import { ANNOTATION_FONT_FAMILY, FRAME_UNITS, canvasAnnotationTextMeasure, firstName, contentRect, createAnnotationPresenceTracker, framePoint, hitTestAnnotation, paintAnnotation, projectFramePoint } from "../src/index";

const rect = { x: 0, y: 0, width: 400, height: 260 };
const author = { participant_id: "viewer", display_name: "Alex", color: "#22cc55" };
const red = "#ee3333";

function point(x: number, y: number): ScreenAnnotationPoint {
  return { x: Math.round(x * FRAME_UNITS), y: Math.round(y * FRAME_UNITS) };
}

function mark(shape: ScreenAnnotationShape, options?: { color?: string; expiry?: number; revision?: number; participantId?: string }): ScreenAnnotationMark {
  const revision = options?.revision ?? 1;
  return {
    author: { ...author, participant_id: options?.participantId ?? author.participant_id },
    created_revision: revision,
    committed_at_ms: 1000,
    expires_at_ms: options?.expiry ?? null,
    draft: { mark_id: String(revision), lifetime: options?.expiry ? "fade" : "keep", color: options?.color ?? red, width: 1000, shape },
  };
}

function pointer(x: number, at: number, fence = 1): ScreenAnnotationPresence {
  return {
    type: "annotation_presence",
    author,
    cursor: { point: point(x, 0.5), tool: "pointer" },
    layer_id: "layer",
    fence,
    draft: null,
    server_at_ms: at,
    expires_at_ms: at + 1000,
  };
}

beforeAll(() => {
  expect(GlobalFonts.registerFromPath(fileURLToPath(new URL("../fonts/Figtree-SemiBold.ttf", import.meta.url)), ANNOTATION_FONT_FAMILY)).toBeTruthy();
});

describe("annotation Canvas renderer", () => {
  it.each([
    [1920, 1080, "fit", 1],
    [1080, 1920, "fit", 2],
    [3840, 2160, "fill", 1.25],
    [720, 1280, "fill", 3],
  ] as const)("paints sampled fiducials in %sx%s %s at %sx DPI", (width, height, fit, dpr) => {
    const viewport = { x: 0, y: 0, width: 320, height: 232 };
    const canvas = createCanvas(viewport.width * dpr, viewport.height * dpr);
    const ctx = canvas.getContext("2d");
    ctx.scale(dpr, dpr);
    const mapped = contentRect({ width, height }, viewport, fit);
    if (!mapped) throw new Error("No mapped frame");
    const expected = [
      { x: 108.3, y: 50.6 },
      { x: 151.9, y: 144.2 },
      { x: 214.5, y: 118.5 },
    ];
    const marks = expected.map((target, index) => {
      const wire = framePoint(mapped, target);
      if (!wire) throw new Error("Fiducial outside frame");
      return mark({ kind: "pen", points: [wire] }, { revision: index + 1 });
    });
    paintAnnotation(ctx, { rect: mapped, clip: viewport, marks, nowMs: 1000 });

    for (const target of expected) {
      const radius = 12;
      const width = radius * 2 + 1;
      const left = Math.floor(target.x * dpr) - radius;
      const top = Math.floor(target.y * dpr) - radius;
      const { data } = ctx.getImageData(left, top, width, width);
      let weight = 0;
      let x = 0;
      let y = 0;
      for (let index = 0; index < width ** 2; index++) {
        const alpha = data[index * 4 + 3] ?? 0;
        weight += alpha;
        x += alpha * (left + (index % width) + 0.5);
        y += alpha * (top + Math.floor(index / width) + 0.5);
      }
      expect(weight).toBeGreaterThan(0);
      expect(Math.hypot(x / weight - target.x * dpr, y / weight - target.y * dpr) / (mapped.width * dpr)).toBeLessThan(0.005);
    }
  });

  it("renders a hollow local touch target without a second laser dot, trail, or name", () => {
    const ctx = createCanvas(400, 260).getContext("2d");
    paintAnnotation(ctx, { rect, marks: [], localTouch: point(0.5, 0.5), nowMs: 1000 });
    expect(ctx.getImageData(200, 130, 1, 1).data[3]).toBe(0);
    expect(ctx.getImageData(188, 130, 1, 1).data[3]).toBeGreaterThan(0);
    expect(ctx.getImageData(240, 149, 1, 1).data[3]).toBe(0);
  });

  it("clips cropped ink, restores caller state, and paints revisions before previews", () => {
    const ctx = createCanvas(400, 260).getContext("2d");
    ctx.globalAlpha = 0.23;
    ctx.setLineDash([1, 5]);
    const shape = { kind: "line", from_point: point(0, 0.5), to_point: point(1, 0.5) } as const;
    const lower = mark(shape, { revision: 1 });
    const upper = mark(shape, { revision: 2, color: "#11dd00" });
    const sample = { ...pointer(0, 1000), cursor: null, draft: { ...upper.draft, color: "#0000ff" } };
    paintAnnotation(ctx, { rect, clip: { x: 80, y: 90, width: 200, height: 160 }, marks: [upper, lower], presence: [sample], nowMs: 1000 });
    expect(ctx.getImageData(80, 130, 1, 1).data).toEqual(new Uint8ClampedArray([17, 221, 0, 255]));
    expect(ctx.getImageData(79, 130, 1, 1).data[3]).toBe(0);
    expect(ctx.getImageData(280, 130, 1, 1).data[3]).toBe(0);
    expect(ctx.globalAlpha).toBeCloseTo(0.23, 2);
    expect(ctx.getLineDash()).toEqual([1, 5]);
  });

  it("uses the same visibility for paint and erasing; highlighter does not darken inside one stroke", () => {
    const ctx = createCanvas(400, 260).getContext("2d");
    const highlighter = mark({ kind: "highlighter", points: [point(0.1, 0.5), point(0.7, 0.5), point(0.2, 0.5)] }, { expiry: 3000 });
    const options = { rect, marks: [highlighter], nowMs: 2700 };
    paintAnnotation(ctx, options);
    for (const x of [65, 110, 185]) {
      expect(ctx.getImageData(x, 130, 1, 1).data[3]).toBeGreaterThanOrEqual(45);
      expect(ctx.getImageData(x, 130, 1, 1).data[3]).toBeLessThanOrEqual(47);
    }
    const at = { x: 140, y: 130 };
    const hitOptions = { ...options, measureText: canvasAnnotationTextMeasure(ctx) };
    expect(hitTestAnnotation(at, hitOptions)).toBe(highlighter);
    expect(hitTestAnnotation(at, { ...hitOptions, nowMs: 3000 })).toBeNull();
    expect(hitTestAnnotation(at, { ...hitOptions, paused: true, sharerId: "other" })).toBeNull();
    expect(hitTestAnnotation(at, { ...hitOptions, canErase: () => false })).toBeNull();
  });

  it("hits the geometry of ellipse, rounded box, arrowhead, note and stamp", () => {
    const ctx = createCanvas(400, 260).getContext("2d");
    const measureText = canvasAnnotationTextMeasure(ctx);
    const hits = (shape: ScreenAnnotationShape, x: number, y: number) => hitTestAnnotation({ x, y }, { rect, marks: [mark(shape)], nowMs: 1000, measureText, tolerance: 0 });
    const bounds = { from_point: point(0.1, 0.2), to_point: point(0.9, 0.8) };
    expect(hits({ kind: "circle", ...bounds }, 360, 130)).not.toBeNull();
    expect(hits({ kind: "circle", ...bounds }, 200, 130)).toBeNull();
    expect(hits({ kind: "circle", ...bounds }, 40, 52)).toBeNull();
    expect(hits({ kind: "box", ...bounds }, 50, 52)).not.toBeNull();
    expect(hits({ kind: "box", ...bounds }, 40, 52)).toBeNull();
    expect(hits({ kind: "arrow", from_point: point(0.15, 0.5), to_point: point(0.85, 0.5) }, 316, 137)).not.toBeNull();
    expect(hits({ kind: "text", at: point(0.15, 0.5), text: "Hello\nworld", note: true }, 52, 180)).not.toBeNull();
    expect(hits({ kind: "stamp", at: point(0.15, 0.5), stamp: "star" }, 86, 148)).not.toBeNull();
  });

  it("paints open geometry and a filled arrowhead at the projected coordinates", () => {
    const ctx = createCanvas(400, 260).getContext("2d");
    const marks = [
      mark({ kind: "box", from_point: point(0.1, 0.2), to_point: point(0.35, 0.5) }, { revision: 1 }),
      mark({ kind: "circle", from_point: point(0.5, 0.2), to_point: point(0.9, 0.5) }, { revision: 2 }),
      mark({ kind: "arrow", from_point: point(0.15, 0.75), to_point: point(0.85, 0.75) }, { revision: 3 }),
    ];
    paintAnnotation(ctx, { rect, marks, nowMs: 1000 });
    for (const [x, y] of [
      [90, 52],
      [280, 52],
      [316, 203],
    ] as const) {
      expect(ctx.getImageData(x, y, 1, 1).data[3]).toBeGreaterThan(245);
    }
    for (const [x, y] of [
      [40, 52],
      [90, 91],
      [280, 91],
    ] as const) {
      expect(ctx.getImageData(x, y, 1, 1).data[3]).toBe(0);
    }
  });

  it("uses vector artwork for every stamp and the bundled font for literal text", () => {
    const ctx = createCanvas(400, 260).getContext("2d");
    const stamps = ["check", "cross", "star", "question", "heart"] as const;
    const centers = stamps.map((_, i) => point(0.14 + i * 0.18, 0.3));
    const marks = stamps.map((stamp, index) => {
      const at = centers[index];
      if (!at) throw new Error("No stamp center");
      return mark({ kind: "stamp", at, stamp }, { revision: index + 1 });
    });
    marks.push(mark({ kind: "text", at: point(0.08, 0.75), text: "A < B", note: true }, { revision: 6 }));
    paintAnnotation(ctx, { rect, marks, nowMs: 1000 });
    const glyphs = centers.map((at) => {
      const center = projectFramePoint(rect, at);
      const { data } = ctx.getImageData(Math.round(center.x) - 26, Math.round(center.y) - 26, 52, 52);
      return Buffer.from(data).toString("base64");
    });
    expect(new Set(glyphs).size).toBe(stamps.length);
    expect(ctx.getImageData(22, 195, 1, 1).data[3]).toBeCloseTo(209, 0);
    const measured = canvasAnnotationTextMeasure(ctx)("A < B", 42);
    expect(measured).toBeGreaterThan(70);
    expect(measured).toBeLessThan(130);
  });

  it("names other people's marks with a first name in their ink, and never the viewer's own", () => {
    const stroke = { kind: "pen", points: [point(0.1, 0.2), point(0.4, 0.2)] } as const;
    const theirs = { ...mark(stroke, { color: "#c15a10", participantId: "omar" }), author: { participant_id: "omar", display_name: "Omar Haddad", color: "#c15a10" } };
    const ctx = createCanvas(400, 260).getContext("2d");
    paintAnnotation(ctx, { rect, marks: [theirs], nowMs: 1000 });
    const tagArea = () => ctx.getImageData(166, 60, 30, 14).data;
    expect(tagArea().some((value, index) => index % 4 === 3 && value > 0)).toBe(false);

    paintAnnotation(ctx, { rect, marks: [theirs], nameMarksExcept: "omar", nowMs: 1000 });
    expect(tagArea().some((value, index) => index % 4 === 3 && value > 0)).toBe(false);

    paintAnnotation(ctx, { rect, marks: [theirs], nameMarksExcept: "nora", nowMs: 1000 });
    const pixels = tagArea();
    const ink = [...Array(pixels.length / 4).keys()].filter((index) => pixels[index * 4] === 0xc1 && pixels[index * 4 + 1] === 0x5a && pixels[index * 4 + 2] === 0x10);
    const text = [...Array(pixels.length / 4).keys()].filter((index) => Math.max(pixels[index * 4] ?? 0, pixels[index * 4 + 1] ?? 0, pixels[index * 4 + 2] ?? 0) < 90 && pixels[index * 4 + 3] === 255);
    expect(ink.length).toBeGreaterThan(40);
    expect(text.length).toBeGreaterThan(0);
    expect(firstName("  Omar  Haddad ")).toBe("Omar");
    expect(firstName("Cher")).toBe("Cher");
  });

  it("paints a named pointer trail briefly and never joins across a fence or reconnect", () => {
    const ctx = createCanvas(400, 260).getContext("2d");
    const track = createAnnotationPresenceTracker();
    track.update([pointer(0.15, 1000)], 1000);
    const sample = pointer(0.65, 1140);
    const presence = track.update([sample], 1140);
    paintAnnotation(ctx, { rect, marks: [], presence, nowMs: 1140 });
    expect(ctx.getImageData(185, 130, 1, 1).data[3]).toBeGreaterThan(0);
    expect(ctx.getImageData(276, 149, 1, 1).data[3]).toBeGreaterThan(0);

    ctx.clearRect(0, 0, 400, 260);
    paintAnnotation(ctx, { rect, marks: [], presence, nowMs: 1520 });
    expect(ctx.getImageData(185, 130, 1, 1).data[3]).toBe(0);
    expect(ctx.getImageData(260, 130, 1, 1).data[3]).toBe(0);
    expect(track.update([pointer(0.4, 1200, 2)], 1200)[0]?.laserTrail).toHaveLength(1);
    track.clear();
    expect(track.update([pointer(0.5, 1250, 2)], 1250)[0]?.laserTrail).toHaveLength(1);
  });
});

// Compile-time proof that browser callers need no context shim.
paintAnnotation satisfies (ctx: CanvasRenderingContext2D, options: Parameters<typeof paintAnnotation>[1]) => void;
