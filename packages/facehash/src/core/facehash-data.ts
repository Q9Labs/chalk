import { stringHash } from "../utils/hash.js";

export type Variant = "gradient" | "solid";

export type FaceType = "round" | "cross" | "line" | "curved";

export type FacehashBlinkTiming = {
  delay: number;
  duration: number;
};

export type FacehashBlinkTimings = {
  left: FacehashBlinkTiming;
  right: FacehashBlinkTiming;
};

export type FacehashData = {
  faceType: FaceType;
  colorIndex: number;
  rotation: { x: number; y: number };
  initial: string;
  blinkTimings: FacehashBlinkTimings;
};

export type ComputeFacehashOptions = {
  name: string;
  colorsLength?: number;
};

const FACE_TYPES: readonly FaceType[] = ["round", "cross", "line", "curved"] as const;

const SPHERE_POSITIONS = [
  { x: -1, y: 1 },
  { x: 1, y: 1 },
  { x: 1, y: 0 },
  { x: 0, y: 1 },
  { x: -1, y: 0 },
  { x: 0, y: 0 },
  { x: 0, y: -1 },
  { x: -1, y: -1 },
  { x: 1, y: -1 },
] as const;

export const DEFAULT_COLORS = ["#ec4899", "#f59e0b", "#3b82f6", "#f97316", "#10b981"] as const;

const FALLBACK_COLOR = "#ec4899";

export function computeFacehash(options: ComputeFacehashOptions): FacehashData {
  const { name, colorsLength = DEFAULT_COLORS.length } = options;

  const hash = stringHash(name);
  const faceIndex = hash % FACE_TYPES.length;
  const colorIndex = hash % colorsLength;
  const positionIndex = hash % SPHERE_POSITIONS.length;
  const position = SPHERE_POSITIONS[positionIndex] ?? { x: 0, y: 0 };
  const blinkSeed = hash * 31;
  const blinkTiming = {
    delay: (blinkSeed % 40) / 10,
    duration: 2 + (blinkSeed % 40) / 10,
  };

  return {
    faceType: FACE_TYPES[faceIndex] ?? "round",
    colorIndex,
    rotation: position,
    initial: name.charAt(0).toUpperCase(),
    blinkTimings: {
      left: { ...blinkTiming },
      right: { ...blinkTiming },
    },
  };
}

export function getColor(colors: readonly string[] | undefined, index: number): string {
  const palette = colors && colors.length > 0 ? colors : DEFAULT_COLORS;
  return palette[index % palette.length] ?? FALLBACK_COLOR;
}
