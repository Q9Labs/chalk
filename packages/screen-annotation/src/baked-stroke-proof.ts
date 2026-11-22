// Escape hatch for ambiguous or unreadable native frames, not evidence that ink arrived.
export const INK_PROOF_TIMEOUT_MS = 1800;

export interface InkRaster {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8ClampedArray;
}

type Color = readonly [number, number, number];
type Background = { readonly offset: number; readonly before: Color };
type Sample = Background & { readonly painted: Color };
export type StrokeProof = {
  readonly width: number;
  readonly height: number;
  readonly samples: readonly (readonly Sample[])[];
  readonly background: readonly Background[];
};

function pixel(data: Uint8ClampedArray, at: number): Color {
  return [data[at] ?? 0, data[at + 1] ?? 0, data[at + 2] ?? 0];
}

function distance(a: Color, b: Color): number {
  return Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]), Math.abs(a[2] - b[2]));
}

function mix(before: Color, color: Color, opacity: number): Color {
  return [before[0] + (color[0] - before[0]) * opacity, before[1] + (color[1] - before[1]) * opacity, before[2] + (color[2] - before[2]) * opacity];
}

function matchesInk(observed: Color, { before, painted }: Sample): boolean {
  const red = painted[0] - before[0];
  const green = painted[1] - before[1];
  const blue = painted[2] - before[2];
  const strength = ((observed[0] - before[0]) * red + (observed[1] - before[1]) * green + (observed[2] - before[2]) * blue) / (red * red + green * green + blue * blue);
  // A thin stroke can land between two decoded pixels. That changes its
  // coverage, not its direction in RGB away from the pre-stroke background.
  if (strength < 0.65 || strength > 1.4) return false;
  return distance(observed, mix(before, painted, strength)) <= Math.min(18, distance(observed, before) * 0.3);
}

type StencilPixel = { readonly offset: number; readonly color: Color; readonly opacity: number };
type PresenceSample = StencilPixel & { readonly pairs: readonly (readonly [number, number])[] };
type PresenceProof = { readonly width: number; readonly height: number; readonly samples: readonly PresenceSample[] };

export type BakedStrokeProof = { readonly changed: StrokeProof | null; readonly present: PresenceProof };

function bodyPixel(data: Uint8ClampedArray, offset: number, stride: number): boolean {
  const alpha = data[offset + 3] ?? 0;
  if (alpha < 0.18 * 255) return false;
  const column = offset % stride;
  const left = column > 0 ? (data[offset - 1] ?? 0) : 0;
  const right = column + 4 < stride ? (data[offset + 7] ?? 0) : 0;
  return alpha >= Math.max(left, right, data[offset + 3 - stride] ?? 0, data[offset + 3 + stride] ?? 0) * 0.75;
}

function stencilPixels(stencil: InkRaster): StencilPixel[] {
  const ink: StencilPixel[] = [];
  for (let offset = 0; offset < stencil.data.length; offset += 4) {
    if (!bodyPixel(stencil.data, offset, stencil.width * 4)) continue;
    // A tappable Android overlay is capped at 80% window opacity.
    ink.push({ offset, color: pixel(stencil.data, offset), opacity: ((stencil.data[offset + 3] ?? 0) / 255) * 0.8 });
  }
  return ink;
}

function distributed<T>(candidates: readonly T[]): readonly T[] {
  const count = Math.min(24, candidates.length);
  return Array.from({ length: count }, (_, index) => candidates[Math.floor(((index + 0.5) * candidates.length) / count)] as T);
}

function sampleAgainst(ink: StencilPixel, offset: number, before: Color): Sample | null {
  const painted = mix(before, ink.color, ink.opacity);
  return distance(before, painted) >= 26 ? { offset, before, painted } : null;
}

function nearbySamples(baseline: InkRaster, ink: StencilPixel): Sample[] {
  const stride = baseline.width * 4;
  const x = (ink.offset % stride) / 4;
  const y = Math.floor(ink.offset / stride);
  const local: Sample[] = [];
  for (let row = Math.max(0, y - 1); row <= Math.min(baseline.height - 1, y + 1); row++) {
    for (let column = Math.max(0, x - 1); column <= Math.min(baseline.width - 1, x + 1); column++) {
      const offset = row * stride + column * 4;
      const sample = sampleAgainst(ink, offset, pixel(baseline.data, offset));
      if (sample) local.push(sample);
    }
  }
  return local;
}

function changedProof(baseline: InkRaster, stencil: InkRaster, ink: readonly StencilPixel[]): StrokeProof | null {
  const { width, height } = baseline;
  const candidates = ink.filter((point) => sampleAgainst(point, point.offset, pixel(baseline.data, point.offset)));
  if (candidates.length < 4) return null;
  const background = new Map<number, Background>();
  const samples = distributed(candidates).map((point) => {
    const neighbor = [point.offset - 12 * width, point.offset + 12 * width].find((offset) => offset >= 0 && offset < stencil.data.length && !stencil.data[offset + 3]);
    if (neighbor !== undefined) background.set(neighbor, { offset: neighbor, before: pixel(baseline.data, neighbor) });
    return nearbySamples(baseline, point);
  });
  return { width, height, samples, background: [...background.values()] };
}

function sameSize(left: InkRaster, right: { readonly width: number; readonly height: number }): boolean {
  return left.width === right.width && left.height === right.height;
}

/** Temporal evidence for the live hand-off; existing ink nearby is not proof. */
export function makeStrokeProof(baseline: InkRaster, stencil: InkRaster): StrokeProof | null {
  return sameSize(baseline, stencil) ? changedProof(baseline, stencil, stencilPixels(stencil)) : null;
}

function outsideStencil(stencil: InkRaster, x: number, y: number): number | null {
  if (x < 0 || x >= stencil.width || y < 0 || y >= stencil.height) return null;
  const offset = (y * stencil.width + x) * 4;
  return stencil.data[offset + 3] ? null : offset;
}

function backgroundPairs(stencil: InkRaster, ink: StencilPixel): PresenceSample["pairs"] {
  const x = (ink.offset / 4) % stencil.width;
  const y = Math.floor(ink.offset / (stencil.width * 4));
  const pairs: [number, number][] = [];
  for (const radius of [3, 5, 9, 17, 33]) {
    for (const [dx, dy] of [
      [radius, 0],
      [0, radius],
    ] as const) {
      const left = outsideStencil(stencil, x - dx, y - dy);
      const right = outsideStencil(stencil, x + dx, y + dy);
      if (left !== null && right !== null) pairs.push([left, right]);
    }
  }
  return pairs;
}

/** A null means the rasterized mark is too small to prove at this frame size. */
export function makeBakedStrokeProof(baseline: InkRaster, stencil: InkRaster): BakedStrokeProof | null {
  if (!sameSize(baseline, stencil)) return null;
  const ink = stencilPixels(stencil);
  if (ink.length < 4) return null;
  const samples = distributed(ink).map((point) => ({ ...point, pairs: backgroundPairs(stencil, point) }));
  return { changed: changedProof(baseline, stencil, ink), present: { width: stencil.width, height: stencil.height, samples } };
}

function presenceHit(frame: InkRaster, ink: PresenceSample): boolean {
  const observed = pixel(frame.data, ink.offset);
  return ink.pairs.some(([left, right]) => {
    const near = pixel(frame.data, left);
    const far = pixel(frame.data, right);
    if (distance(near, far) > 20) return false;
    const sample = sampleAgainst(ink, ink.offset, mix(near, far, 0.5));
    return sample !== null && matchesInk(observed, sample);
  });
}

/** Save can also use spatial evidence when the first decoded frame already contains the mark. */
export function frameContainsStroke(frame: InkRaster, proof: BakedStrokeProof): boolean {
  if (proof.changed && frameProvesStroke(frame, proof.changed)) return true;
  if (!sameSize(frame, proof.present)) return false;
  const { samples } = proof.present;
  return samples.filter((ink) => presenceHit(frame, ink)).length >= Math.max(4, Math.ceil(samples.length * 0.8));
}

export function frameProvesStroke(frame: InkRaster, proof: StrokeProof): boolean {
  if (!sameSize(frame, proof)) return false;
  const hits = proof.samples.filter((local) => local.some((sample) => matchesInk(pixel(frame.data, sample.offset), sample)));
  if (hits.length < Math.max(4, Math.ceil(proof.samples.length * 0.8))) return false;
  const steady = proof.background.filter(({ offset, before }) => distance(pixel(frame.data, offset), before) <= 35);
  return steady.length >= Math.ceil(proof.background.length * 0.65);
}

export function inkHandoff({
  baked,
  revision,
  nowMs,
  mark,
  preview,
  proved,
}: {
  readonly baked: boolean;
  readonly revision: number;
  readonly nowMs: number;
  readonly mark: { readonly expires_at_ms: number | null } | undefined;
  readonly preview: { readonly startedBaked: boolean; readonly expiresAt: number; readonly revision?: number; readonly proofTimeoutAt?: number };
  readonly proved: boolean;
}): "local" | "video" | "data" | "removed" {
  if ((!mark && preview.revision !== undefined && revision >= preview.revision) || (mark?.expires_at_ms != null && mark.expires_at_ms <= nowMs)) return "removed";
  if (baked && proved) return "video";
  if (!baked && mark) return "data";
  if ((preview.proofTimeoutAt ?? Infinity) <= nowMs || (!preview.startedBaked && preview.expiresAt <= nowMs)) return "removed";
  return "local";
}
