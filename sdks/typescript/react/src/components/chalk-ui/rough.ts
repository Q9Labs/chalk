// Geometry adapted from Drawably/Chalkably (MIT; Daniel Belyi). The seeded path model is retained.
import { mulberry32 } from "./prng";

export interface RoughOptions {
  readonly seed: number;
  readonly roughness: number;
  readonly boil?: number;
  readonly boilSeed?: number;
}

type Point = readonly [number, number];

function sampleLine(x1: number, y1: number, x2: number, y2: number, step = 8): Point[] {
  const count = Math.max(2, Math.ceil(Math.hypot(x2 - x1, y2 - y1) / step));
  return Array.from({ length: count + 1 }, (_, index) => [x1 + ((x2 - x1) * index) / count, y1 + ((y2 - y1) * index) / count]);
}

function arcPoints(cx: number, cy: number, radius: number, start: number, end: number, count = 4): Point[] {
  return Array.from({ length: count + 1 }, (_, index) => {
    const angle = start + ((end - start) * index) / count;
    return [cx + radius * Math.cos(angle), cy + radius * Math.sin(angle)];
  });
}

function roundedRectPoints(x: number, y: number, width: number, height: number, radius: number): Point[] {
  const safeRadius = Math.max(0, Math.min(radius, width / 2, height / 2));
  return [
    ...sampleLine(x + safeRadius, y, x + width - safeRadius, y),
    ...arcPoints(x + width - safeRadius, y + safeRadius, safeRadius, -Math.PI / 2, 0),
    ...sampleLine(x + width, y + safeRadius, x + width, y + height - safeRadius),
    ...arcPoints(x + width - safeRadius, y + height - safeRadius, safeRadius, 0, Math.PI / 2),
    ...sampleLine(x + width - safeRadius, y + height, x + safeRadius, y + height),
    ...arcPoints(x + safeRadius, y + height - safeRadius, safeRadius, Math.PI / 2, Math.PI),
    ...sampleLine(x, y + height - safeRadius, x, y + safeRadius),
    ...arcPoints(x + safeRadius, y + safeRadius, safeRadius, Math.PI, Math.PI * 1.5),
  ];
}

function jitter(points: readonly Point[], random: () => number, amplitude: number): Point[] {
  return points.map(([x, y]) => [x + (random() * 2 - 1) * amplitude, y + (random() * 2 - 1) * amplitude]);
}

function toPath(points: readonly Point[], close: boolean): string {
  const first = points[0] ?? [0, 0];
  let path = `M${first[0].toFixed(2)} ${first[1].toFixed(2)}`;
  for (let index = 1; index < points.length - 1; index += 1) {
    const current = points[index] ?? first;
    const next = points[index + 1] ?? current;
    const middleX = (current[0] + next[0]) / 2;
    const middleY = (current[1] + next[1]) / 2;
    path += `Q${current[0].toFixed(2)} ${current[1].toFixed(2)} ${middleX.toFixed(2)} ${middleY.toFixed(2)}`;
  }
  const last = points.at(-1) ?? first;
  path += `L${last[0].toFixed(2)} ${last[1].toFixed(2)}`;
  return close ? `${path}Z` : path;
}

function boilPass(points: readonly Point[], options: RoughOptions): Point[] {
  if (!options.boil || options.boilSeed === undefined) return [...points];
  return jitter(points, mulberry32(options.boilSeed), options.boil);
}

function doubleStroke(points: readonly Point[], options: RoughOptions, close: boolean): string {
  const random = mulberry32(options.seed);
  const amplitude = 1.5 * options.roughness;
  const first = boilPass(jitter(points, random, amplitude), options);
  const second = boilPass(jitter(points, random, amplitude * 1.4), options);
  return `${toPath(first, close)} ${toPath(second, close)}`;
}

export function roughLine(x1: number, y1: number, x2: number, y2: number, options: RoughOptions): string {
  return doubleStroke(sampleLine(x1, y1, x2, y2), options, false);
}

export function roughCircle(cx: number, cy: number, radius: number, options: RoughOptions): string {
  const count = Math.max(8, Math.ceil((2 * Math.PI * radius) / 8));
  return doubleStroke(arcPoints(cx, cy, Math.max(0, radius), 0, Math.PI * 2, count).slice(0, -1), options, true);
}

export function roughRoundedRect(x: number, y: number, width: number, height: number, radius: number, options: RoughOptions): string {
  return doubleStroke(roundedRectPoints(x, y, Math.max(1, width), Math.max(1, height), radius), options, true);
}

export function roughCheckmark(x: number, y: number, width: number, height: number, options: RoughOptions): string {
  const random = mulberry32(options.seed);
  const points = [...sampleLine(x, y + height * 0.6, x + width * 0.35, y + height, 4), ...sampleLine(x + width * 0.35, y + height, x + width, y, 4)];
  return toPath(boilPass(jitter(points, random, 1.2 * options.roughness), options), false);
}

export function scribbleFill(x: number, y: number, width: number, height: number, options: RoughOptions): string {
  const random = mulberry32(options.seed);
  const gap = 6;
  const points: Point[] = [];
  let flip = false;
  for (let position = gap; position < width + height; position += gap) {
    const start: Point = [x + Math.max(0, position - height), y + Math.min(position, height)];
    const end: Point = [x + Math.min(position, width), y + Math.max(0, position - width)];
    points.push(...(flip ? [end, start] : [start, end]));
    flip = !flip;
  }
  return points.length < 2 ? "" : toPath(boilPass(jitter(points, random, 1.2 * options.roughness), options), false);
}

export function variants(generator: (options: RoughOptions) => string, options: RoughOptions, count = 3): string[] {
  return Array.from({ length: Math.max(1, count) }, (_, index) => generator({ ...options, boilSeed: options.seed + (index + 1) * 7919 }));
}
