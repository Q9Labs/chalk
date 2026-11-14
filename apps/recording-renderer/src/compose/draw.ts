import { createCanvas, Path2D, type Canvas, type Image, type SKRSContext2D } from "@napi-rs/canvas";
import type { Rect, Scene } from "./scene.js";

/** The painter's colors, from design.md: Chalk Light and its dark counterpart. */
export interface Theme {
  readonly paper: string;
  readonly surface: string;
  readonly ink: string;
  readonly ink2: string;
  readonly line: string;
  readonly washes: readonly string[];
}

export const THEMES: Readonly<Record<Scene["colorScheme"], Theme>> = {
  light: { paper: "#F7F6F2", surface: "#FFFFFF", ink: "#0C0E12", ink2: "#555B65", line: "#DEDDD7", washes: ["#EDF6EB", "#FFF8E5", "#EAF7FB", "#FDF0F0"] },
  dark: { paper: "#0C0E12", surface: "#16191F", ink: "#F2F1ED", ink2: "#A3A8B0", line: "#2A2E35", washes: ["#1B2419", "#262214", "#16232A", "#2A1B1B"] },
};

export const IDENTITY_COLORS = ["#315F72", "#5C6650", "#6B5B4F", "#64576B", "#49645D", "#665D42", "#4D5D73", "#6D5158"] as const;
export const SPEAKING = "#80B879";
export const HAND = "#D9B641";
export const RECORDING = "#D67B7B";
export const DANGER = "#E28C8C";
export const NAME_TAG = "rgba(12, 14, 18, 0.80)";
export const TILE_RADIUS = 10;
export const TAG_RADIUS = 5;

export type IconNode = readonly (readonly [string, Readonly<Record<string, string | number>>])[];

export interface PaintKitOptions {
  readonly width: number;
  readonly height: number;
  /** CSS family list for interface text, from registerSubsetFamily. */
  readonly fontFamilies: string;
  readonly loadAsset: (assetId: string) => Promise<Image>;
  readonly renderWhiteboard: (stateAssetId: string, colorScheme: Scene["colorScheme"], rect: Rect, revision?: number) => Promise<Canvas>;
}

/** Everything a paint function needs: the canvas context, the 1280-pixel design scale, and the asset loaders. */
export interface PaintKit {
  readonly canvas: Canvas;
  readonly context: SKRSContext2D;
  readonly width: number;
  readonly height: number;
  readonly loadAsset: PaintKitOptions["loadAsset"];
  readonly renderWhiteboard: PaintKitOptions["renderWhiteboard"];
  /** Design pixels to canvas pixels. */
  readonly px: (value: number) => number;
  readonly font: (weight: number, size: number) => string;
}

export function createPaintKit(options: PaintKitOptions): PaintKit {
  const scale = options.width / 1280;
  const canvas = createCanvas(options.width, options.height);
  return {
    canvas,
    context: canvas.getContext("2d"),
    width: options.width,
    height: options.height,
    loadAsset: options.loadAsset,
    renderWhiteboard: options.renderWhiteboard,
    px: (value) => value * scale,
    font: (weight, size) => `${weight} ${Math.round(size * scale)}px ${options.fontFamilies}`,
  };
}

export function roundedPath(context: SKRSContext2D, rect: Rect, radius: number): void {
  context.beginPath();
  context.roundRect(rect.x, rect.y, rect.width, rect.height, Math.max(0, Math.min(radius, rect.width / 2, rect.height / 2)));
}

export function inset(rect: Rect, amount: number): Rect {
  return { x: rect.x + amount, y: rect.y + amount, width: Math.max(0, rect.width - amount * 2), height: Math.max(0, rect.height - amount * 2) };
}

export function strokeTile(kit: PaintKit, rect: Rect, color: string, width: number): void {
  kit.context.strokeStyle = color;
  kit.context.lineWidth = width;
  roundedPath(kit.context, inset(rect, width / 2), kit.px(TILE_RADIUS) - width / 2);
  kit.context.stroke();
}

/** Scales the image to fit inside `rect` and centers it. */
export function drawContained(context: SKRSContext2D, image: Image | Canvas, rect: Rect): void {
  drawScaled(context, image, rect, Math.min(rect.width / image.width, rect.height / image.height));
}

/** Scales the image to cover `rect` and centers it; the context clip trims the overflow. */
export function drawCovered(context: SKRSContext2D, image: Image, rect: Rect): void {
  drawScaled(context, image, rect, Math.max(rect.width / image.width, rect.height / image.height));
}

function drawScaled(context: SKRSContext2D, image: Image | Canvas, rect: Rect, ratio: number): void {
  const width = image.width * ratio;
  const height = image.height * ratio;
  context.drawImage(image, rect.x + (rect.width - width) / 2, rect.y + (rect.height - height) / 2, width, height);
}

export function ellipsize(context: SKRSContext2D, text: string, maxWidth: number): string {
  if (context.measureText(text).width <= maxWidth) return text;
  const characters = [...text];
  while (characters.length > 1 && context.measureText(`${characters.join("")}…`).width > maxWidth) characters.pop();
  return `${characters.join("")}…`;
}

export function initials(displayName: string): string {
  const words = displayName.trim().split(/\s+/).filter(Boolean);
  const letters = words.length > 1 ? [words[0]!, words.at(-1)!].map((word) => [...word][0]) : [...(words[0] ?? "?")].slice(0, 2);
  return letters.join("").toUpperCase();
}

/** A stable number for a participant ID, to pick the same color every frame. */
export function hash(value: string): number {
  let result = 0;
  for (const character of value) result = (Math.imul(result, 31) + character.codePointAt(0)!) >>> 0;
  return result;
}

export function drawIcon(kit: PaintKit, icon: IconNode, x: number, y: number, size: number, color: string): void {
  const { context } = kit;
  context.save();
  context.translate(x, y);
  context.scale(size / 24, size / 24);
  context.strokeStyle = color;
  context.fillStyle = color;
  context.lineCap = "round";
  context.lineJoin = "round";
  for (const [tag, attributes] of icon) {
    if (tag === "path" && typeof attributes.d === "string") paintIconPath(context, attributes.d, attributes);
  }
  context.restore();
}

function paintIconPath(context: SKRSContext2D, d: string, attributes: IconNode[number][1]): void {
  const path = new Path2D(d);
  if (attributes.fill === "currentColor") context.fill(path);
  if (attributes.stroke === "currentColor") {
    context.lineWidth = Number(attributes.strokeWidth ?? 1.5) * 1.2;
    context.stroke(path);
  }
}
