import { roughCheckmark, roughCircle, roughLine, roughRoundedRect, scribbleFill, type RoughOptions, variants } from "./rough";
import { chalkTexture, type ChalkTexture } from "./texture";

export type ChalkShape = "rect" | "circle" | "line" | "check";

export interface ChalkShapeOptions {
  readonly shape: ChalkShape;
  readonly width: number;
  readonly height: number;
  readonly radius?: number;
  readonly roughness: number;
  readonly seed: number;
  readonly frameCount?: number;
  readonly scribble?: boolean;
}

export interface ChalkPathLayer {
  readonly d: string;
  readonly texture: ChalkTexture | undefined;
  readonly layer: "fill" | "core" | "powder" | "edge" | "focus";
  readonly frame: number;
  readonly pathLength?: string;
}

const INSET = 3;

function basePath(options: ChalkShapeOptions, rough: RoughOptions): string {
  const { width, height } = options;
  if (options.shape === "circle") return roughCircle(width / 2, height / 2, Math.min(width, height) / 2 - INSET, rough);
  if (options.shape === "line") return roughLine(INSET, height / 2, width - INSET, height / 2, rough);
  if (options.shape === "check") return roughCheckmark(width * 0.2, height * 0.2, width * 0.6, height * 0.6, rough);
  return roughRoundedRect(INSET, INSET, width - INSET * 2, height - INSET * 2, options.radius ?? 8, rough);
}

function focusPath(options: ChalkShapeOptions, rough: RoughOptions): string {
  const { width, height } = options;
  if (options.shape === "circle") return roughCircle(width / 2, height / 2, Math.min(width, height) / 2 + 1, rough);
  if (options.shape === "line") return roughLine(0, height / 2, width, height / 2, rough);
  if (options.shape === "check") return roughCheckmark(width * 0.19, height * 0.19, width * 0.62, height * 0.62, rough);
  return roughRoundedRect(-1, -1, width + 2, height + 2, (options.radius ?? 8) + 2, rough);
}

function fillPath(options: ChalkShapeOptions, rough: RoughOptions): string {
  const { width, height } = options;
  if (options.shape === "circle") return roughCircle(width / 2, height / 2, Math.min(width, height) / 2 - INSET - 1, rough);
  return roughRoundedRect(INSET, INSET, width - INSET * 2, height - INSET * 2, options.radius ?? 8, rough);
}

export function generateChalkLayers(options: ChalkShapeOptions): ChalkPathLayer[] {
  const rough: RoughOptions = { seed: options.seed, roughness: options.roughness, boil: 0.35 };
  const count = Math.max(1, options.frameCount ?? 1);
  const layers: ChalkPathLayer[] = [];
  if (options.scribble && options.shape === "rect") {
    for (let frame = 0; frame < count; frame += 1) {
      const frameRough = { ...rough, seed: options.seed, boilSeed: options.seed + (frame + 1) * 7919 };
      layers.push({ d: scribbleFill(INSET + 2, INSET + 2, options.width - INSET * 2 - 4, options.height - INSET * 2 - 4, frameRough), layer: "fill", frame, texture: undefined });
    }
  }
  for (let frame = 0; frame < count; frame += 1) {
    const frameOptions: RoughOptions = { ...rough, boilSeed: options.seed + (frame + 1) * 7919 };
    const d = basePath(options, frameOptions);
    const pathLength = options.shape === "check" ? "1" : undefined;
    layers.push({ d, layer: "core", frame, pathLength, texture: chalkTexture(options.seed, 0, frame) });
    layers.push({ d, layer: "powder", frame, pathLength, texture: chalkTexture(options.seed, 1, frame) });
    layers.push({ d, layer: "edge", frame, pathLength, texture: chalkTexture(options.seed, 2, frame) });
  }
  const focusRough: RoughOptions = { ...rough, seed: options.seed + 31337 };
  layers.push({ d: focusPath(options, focusRough), layer: "focus", frame: 0, texture: undefined });
  return layers;
}

export function generateChalkFill(options: ChalkShapeOptions): string {
  return fillPath(options, { seed: options.seed, roughness: options.roughness, boil: 0.35, boilSeed: options.seed + 7919 });
}

export function generateChalkVariants(options: ChalkShapeOptions): string[] {
  const rough: RoughOptions = { seed: options.seed, roughness: options.roughness, boil: 0.35 };
  return variants((frame) => basePath(options, frame), rough, options.frameCount ?? 1);
}
