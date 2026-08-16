import { mulberry32 } from "./prng";

export interface ChalkTexture {
  readonly coreDash: string;
  readonly powderDash: string;
  readonly edgeDash: string;
  readonly coreOpacity: string;
  readonly powderOpacity: string;
  readonly edgeOpacity: string;
  readonly edgeX: string;
  readonly edgeY: string;
}

function between(random: () => number, minimum: number, maximum: number): number {
  return minimum + (maximum - minimum) * random();
}

function dash(random: () => number, markMinimum: number, markMaximum: number, gapMinimum: number, gapMaximum: number): string {
  return [between(random, markMinimum, markMaximum), between(random, gapMinimum, gapMaximum), between(random, markMinimum * 0.35, markMaximum * 0.8), between(random, gapMinimum * 0.7, gapMaximum * 1.25)].map((value) => value.toFixed(2)).join(" ");
}

export function chalkTexture(seed: number, layer: number, frame: number): ChalkTexture {
  const random = mulberry32(seed + layer * 1009 + frame * 31337);
  return {
    coreDash: dash(random, 18, 38, 1.5, 6),
    powderDash: dash(random, 4, 14, 3, 12),
    edgeDash: dash(random, 8, 24, 5, 18),
    coreOpacity: between(random, 0.82, 0.96).toFixed(2),
    powderOpacity: between(random, 0.18, 0.38).toFixed(2),
    edgeOpacity: between(random, 0.12, 0.28).toFixed(2),
    edgeX: between(random, -0.65, 0.65).toFixed(2),
    edgeY: between(random, -0.65, 0.65).toFixed(2),
  };
}
