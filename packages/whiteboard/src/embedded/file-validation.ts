import { WHITEBOARD_MAX_FILE_BYTES } from "../collab/file-data";

const MAX_IMAGE_DIMENSION = 16_384;
const MAX_DECODED_IMAGE_BYTES = 64 * 1024 * 1024;
const permittedMimeTypes = new Set(["application/octet-stream", "image/gif", "image/jpeg", "image/png", "image/svg+xml", "image/webp"]);

export function normalizeMimeType(value: string): string {
  const mimeType = value.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  if (!permittedMimeTypes.has(mimeType)) throw new Error("whiteboard file MIME type is not permitted");
  return mimeType;
}

export async function validateFileBlob(blob: Blob, claimedMimeType: string): Promise<{ readonly bytes: Uint8Array; readonly mimeType: string }> {
  if (blob.size <= 0 || blob.size > WHITEBOARD_MAX_FILE_BYTES) throw new Error("whiteboard file exceeds the renderer transfer limit");
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const claimed = normalizeMimeType(claimedMimeType);
  validateDeclaredType(blob.type, claimed);
  const mimeType = resolveMimeType(bytes, claimed);
  validateImage(bytes, mimeType);
  return { bytes, mimeType };
}

const binary = "application/octet-stream";

function validateDeclaredType(type: string, claimed: string): void {
  const declared = type ? normalizeMimeType(type) : binary;
  if (claimed !== binary && declared !== claimed) throw new Error("whiteboard file declared MIME type does not match");
}

function resolveMimeType(bytes: Uint8Array, claimed: string): string {
  const detected = detectFileMimeType(bytes);
  if (claimed === binary) return detected ?? claimed;
  validateSignature(claimed, detected);
  return claimed;
}

function validateSignature(claimed: string, detected: string | null): void {
  if (detected) {
    if (claimed !== detected) throw new Error("whiteboard file MIME signature does not match");
  } else if (claimed.startsWith("image/")) {
    throw new Error("whiteboard image signature is invalid");
  }
}

function validateImage(bytes: Uint8Array, mimeType: string): void {
  if (!mimeType.startsWith("image/")) return;
  const dimensions = imageDimensions(bytes, mimeType);
  if (!dimensions) throw new Error("whiteboard image dimensions are invalid");
  validateImageDimensions(dimensions);
  if (mimeType === "image/svg+xml") validateSvg(new TextDecoder().decode(bytes));
}

const svgRoot = /^\s*(?:<\?xml[^>]*>\s*)?<svg(?:\s|>)/iu;
const imageSignatures: readonly [string, (bytes: Uint8Array) => boolean][] = [
  ["image/png", (bytes) => hasBytes(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])],
  ["image/jpeg", (bytes) => hasBytes(bytes, [0xff, 0xd8, 0xff])],
  ["image/gif", (bytes) => ["GIF87a", "GIF89a"].includes(ascii(bytes, 0, 6))],
  ["image/webp", (bytes) => ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP"],
  ["image/svg+xml", (bytes) => svgRoot.test(new TextDecoder().decode(bytes.subarray(0, 1_024)).replace(/^\uFEFF/u, ""))],
];

export function detectFileMimeType(bytes: Uint8Array): string | null {
  return imageSignatures.find(([, matches]) => matches(bytes))?.[0] ?? null;
}

type Dimensions = { readonly width: number; readonly height: number };
const readers = new Map<string, (bytes: Uint8Array) => Dimensions | null>([
  ["image/png", pngDimensions],
  ["image/gif", gifDimensions],
  ["image/jpeg", jpegDimensions],
  ["image/webp", webpDimensions],
  ["image/svg+xml", (bytes) => svgDimensions(new TextDecoder().decode(bytes))],
]);

export function imageDimensions(bytes: Uint8Array, mimeType: string): Dimensions | null {
  return readers.get(mimeType)?.(bytes) ?? null;
}

function pngDimensions(bytes: Uint8Array): Dimensions | null {
  if (bytes.length < 24) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

function gifDimensions(bytes: Uint8Array): Dimensions | null {
  if (bytes.length < 10) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint16(6, true), height: view.getUint16(8, true) };
}

function jpegDimensions(bytes: Uint8Array): Dimensions | null {
  for (let offset = 2; offset + 8 < bytes.length; ) {
    const segment = jpegSegment(bytes, offset);
    if (segment.size === 0) return null;
    if (segment.dimensions) return segment.dimensions;
    offset += segment.size;
  }
  return null;
}

const jpegFrameMarkers = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

function jpegSegment(bytes: Uint8Array, offset: number): { readonly size: number; readonly dimensions?: Dimensions } {
  if (bytes[offset] !== 0xff) return { size: 1 };
  const marker = bytes[offset + 1]!;
  if (marker === 0xd8 || marker === 0xd9) return { size: 2 };
  return jpegPayload(bytes, offset + 2, marker);
}

function jpegPayload(bytes: Uint8Array, offset: number, marker: number): { readonly size: number; readonly dimensions?: Dimensions } {
  const length = (bytes[offset]! << 8) | bytes[offset + 1]!;
  if (length < 2 || offset + length > bytes.length) return { size: 0 };
  const size = 2 + length;
  if (!jpegFrameMarkers.has(marker)) return { size };
  return { size, dimensions: { height: (bytes[offset + 3]! << 8) | bytes[offset + 4]!, width: (bytes[offset + 5]! << 8) | bytes[offset + 6]! } };
}

const webpReaders = new Map([
  ["VP8X", extendedWebpDimensions],
  ["VP8 ", lossyWebpDimensions],
  ["VP8L", losslessWebpDimensions],
]);

function webpDimensions(bytes: Uint8Array): Dimensions | null {
  return webpReaders.get(ascii(bytes, 12, 4))?.(bytes) ?? null;
}

function extendedWebpDimensions(bytes: Uint8Array): Dimensions | null {
  return bytes.length >= 30 ? { width: 1 + uint24(bytes, 24), height: 1 + uint24(bytes, 27) } : null;
}

function lossyWebpDimensions(bytes: Uint8Array): Dimensions | null {
  if (bytes.length < 30 || !hasBytes(bytes, [0x9d, 0x01, 0x2a], 23)) return null;
  return { width: (bytes[26]! | (bytes[27]! << 8)) & 0x3fff, height: (bytes[28]! | (bytes[29]! << 8)) & 0x3fff };
}

function losslessWebpDimensions(bytes: Uint8Array): Dimensions | null {
  if (bytes.length < 25 || bytes[20] !== 0x2f) return null;
  return { width: 1 + (bytes[21]! | ((bytes[22]! & 0x3f) << 8)), height: 1 + ((bytes[22]! >> 6) | (bytes[23]! << 2) | ((bytes[24]! & 0x0f) << 10)) };
}

function svgDimensions(svg: string): { readonly width: number; readonly height: number } | null {
  const root = /^\s*(?:<\?xml[^>]*>\s*)?<svg\b([^>]*)>/iu.exec(svg)?.[1];
  if (!root) return null;
  return svgAttributeDimensions(root) ?? svgViewBoxDimensions(root);
}

function svgAttributeDimensions(root: string): Dimensions | null {
  const width = numericSvgAttribute(root, "width");
  const height = numericSvgAttribute(root, "height");
  return width && height ? { width, height } : null;
}

function svgViewBoxDimensions(root: string): Dimensions | null {
  const viewBox = /\bviewBox\s*=\s*["']\s*[-+\d.eE]+\s+[-+\d.eE]+\s+([-+\d.eE]+)\s+([-+\d.eE]+)\s*["']/u.exec(root);
  if (!viewBox) return null;
  return { width: Number(viewBox[1]), height: Number(viewBox[2]) };
}

function numericSvgAttribute(attributes: string, name: string): number | null {
  const match = new RegExp(`\\b${name}\\s*=\\s*["']\\s*([-+\\d.eE]+)`, "u").exec(attributes);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : null;
}

export function validateImageDimensions({ width, height }: Dimensions): void {
  if (!validDimension(width) || !validDimension(height) || width * height * 4 > MAX_DECODED_IMAGE_BYTES) {
    throw new Error("whiteboard image dimensions exceed the decoded-memory limit");
  }
}

function validDimension(value: number): boolean {
  return Number.isFinite(value) && value > 0 && value <= MAX_IMAGE_DIMENSION;
}

const unsafeSvgPatterns = [/<!DOCTYPE|<!ENTITY/iu, /<(?:script|foreignObject|iframe|object|embed|audio|video|use|image)\b/iu, /\bon[a-z]+\s*=/iu, /\b(?:href|src)\s*=\s*["']?\s*(?:https?:|\/\/|javascript:)/iu, /\burl\(\s*["']?\s*(?:https?:|\/\/|javascript:)/iu];

function validateSvg(svg: string): void {
  if (!svgRoot.test(svg) || unsafeSvgPatterns.some((pattern) => pattern.test(svg))) throw new Error("whiteboard SVG contains unsafe external or executable content");
}

function hasBytes(bytes: Uint8Array, expected: readonly number[], offset = 0): boolean {
  return expected.every((value, index) => bytes[offset + index] === value);
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(offset, offset + length));
}

function uint24(bytes: Uint8Array, offset: number): number {
  return bytes[offset]! | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16);
}
