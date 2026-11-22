// Escape hatch for ambiguous or unreadable native frames, not evidence that ink arrived.
export const NATIVE_INK_PROOF_TIMEOUT_MS = 1800;

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

/** The stencil is straight-alpha ink rendered over transparency at the analysis size. */
export function makeStrokeProof(baseline: InkRaster, stencil: InkRaster): StrokeProof | null {
  if (baseline.width !== stencil.width || baseline.height !== stencil.height) return null;
  const { width, height } = baseline;
  const candidates = [];
  const background = new Map<number, Background>();
  const stride = width * 4;
  for (let offset = 0; offset < stencil.data.length; offset += 4) {
    // A tappable Android overlay is capped at 80% window opacity.
    const opacity = ((stencil.data[offset + 3] ?? 0) / 255) * 0.8;
    if (opacity < 0.18 * 0.8) continue;
    const before = pixel(baseline.data, offset);
    const color = pixel(stencil.data, offset);
    const painted = mix(before, color, opacity);
    if (distance(before, painted) < 26) continue;
    candidates.push({ offset, color, opacity });
  }
  if (candidates.length < 4) return null;
  const samples = [];
  const count = Math.min(24, candidates.length);
  for (let index = 0; index < count; index++) {
    const ink = candidates[Math.floor(((index + 0.5) * candidates.length) / count)];
    if (!ink) continue;
    // The sharer's window and the decoded video can rasterize a thin line on
    // neighboring pixels. Each neighbor must change from its own baseline;
    // existing ink of the same color nearby is not proof.
    const local: Sample[] = [];
    const x = (ink.offset % stride) / 4;
    const y = Math.floor(ink.offset / stride);
    for (let row = Math.max(0, y - 1); row <= Math.min(height - 1, y + 1); row++) {
      for (let column = Math.max(0, x - 1); column <= Math.min(width - 1, x + 1); column++) {
        const offset = row * stride + column * 4;
        const before = pixel(baseline.data, offset);
        const painted = mix(before, ink.color, ink.opacity);
        if (distance(before, painted) >= 26) local.push({ offset, before, painted });
      }
    }
    samples.push(local);
    for (const neighbor of [ink.offset - 3 * stride, ink.offset + 3 * stride]) {
      if (neighbor < 0 || neighbor >= stencil.data.length || stencil.data[neighbor + 3]) continue;
      const before = pixel(baseline.data, neighbor);
      background.set(neighbor, { offset: neighbor, before });
      break;
    }
  }
  return { width, height, samples, background: [...background.values()] };
}

export function frameProvesStroke(frame: InkRaster, proof: StrokeProof): boolean {
  if (frame.width !== proof.width || frame.height !== proof.height) return false;
  const hits = proof.samples.filter((local) =>
    local.some(({ offset, before, painted }) => {
      const observed = pixel(frame.data, offset);
      const error = distance(observed, painted);
      return error <= 28 && error <= distance(observed, before) * 0.55;
    }),
  );
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
