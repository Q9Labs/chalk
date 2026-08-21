import { stringHash } from "../utils/hash";

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
const DARK_FOREGROUND = "#111827";
const LIGHT_FOREGROUND = "#ffffff";

function parseHexColor(color: string): readonly [number, number, number] | undefined {
  const value = color.trim().replace(/^#/, "");
  const expanded = value.length === 3 ? [...value].map((character) => `${character}${character}`).join("") : value;
  if (!/^[\da-f]{6}$/i.test(expanded)) return undefined;

  return [Number.parseInt(expanded.slice(0, 2), 16), Number.parseInt(expanded.slice(2, 4), 16), Number.parseInt(expanded.slice(4, 6), 16)];
}

function relativeLuminance(color: readonly [number, number, number]): number {
  const linearize = (channel: number) => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };

  return 0.2126 * linearize(color[0]) + 0.7152 * linearize(color[1]) + 0.0722 * linearize(color[2]);
}

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

export function getForegroundColor(backgroundColor: string): string {
  const background = parseHexColor(backgroundColor);
  const dark = parseHexColor(DARK_FOREGROUND);
  const light = parseHexColor(LIGHT_FOREGROUND);
  if (!background || !dark || !light) return LIGHT_FOREGROUND;

  const backgroundLuminance = relativeLuminance(background);
  const darkContrast = (backgroundLuminance + 0.05) / (relativeLuminance(dark) + 0.05);
  const lightContrast = (relativeLuminance(light) + 0.05) / (backgroundLuminance + 0.05);
  return darkContrast > lightContrast ? DARK_FOREGROUND : LIGHT_FOREGROUND;
}
