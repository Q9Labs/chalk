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
  const declared = blob.type ? normalizeMimeType(blob.type) : "application/octet-stream";
  if (claimed !== "application/octet-stream" && declared !== claimed) {
    throw new Error("whiteboard file declared MIME type does not match");
  }
  const detected = detectFileMimeType(bytes);
  const mimeType = claimed === "application/octet-stream" && detected ? detected : claimed;
  if (detected && mimeType !== detected) throw new Error("whiteboard file MIME signature does not match");
  if (mimeType.startsWith("image/") && !detected) throw new Error("whiteboard image signature is invalid");

  const dimensions = imageDimensions(bytes, mimeType);
  if (mimeType.startsWith("image/") && !dimensions) throw new Error("whiteboard image dimensions are invalid");
  if (dimensions) validateImageDimensions(dimensions);
  if (mimeType === "image/svg+xml") validateSvg(new TextDecoder().decode(bytes));
  return { bytes, mimeType };
}

export function detectFileMimeType(bytes: Uint8Array): string | null {
  if (hasBytes(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (hasBytes(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (ascii(bytes, 0, 6) === "GIF87a" || ascii(bytes, 0, 6) === "GIF89a") return "image/gif";
  if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP") return "image/webp";
  const prefix = new TextDecoder().decode(bytes.subarray(0, Math.min(bytes.length, 1_024))).replace(/^\uFEFF/u, "");
  if (/^\s*(?:<\?xml[^>]*>\s*)?<svg(?:\s|>)/iu.test(prefix)) return "image/svg+xml";
  return null;
}

export function imageDimensions(bytes: Uint8Array, mimeType: string): { readonly width: number; readonly height: number } | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  switch (mimeType) {
    case "image/png":
      return bytes.length >= 24 ? { width: view.getUint32(16), height: view.getUint32(20) } : null;
    case "image/gif":
      return bytes.length >= 10 ? { width: view.getUint16(6, true), height: view.getUint16(8, true) } : null;
    case "image/jpeg":
      return jpegDimensions(bytes);
    case "image/webp":
      return webpDimensions(bytes);
    case "image/svg+xml":
      return svgDimensions(new TextDecoder().decode(bytes));
    default:
      return null;
  }
}

function jpegDimensions(bytes: Uint8Array): { readonly width: number; readonly height: number } | null {
  let offset = 2;
  while (offset + 8 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = bytes[offset + 1] ?? 0;
    offset += 2;
    if (marker === 0xd8 || marker === 0xd9) continue;
    if (offset + 2 > bytes.length) return null;
    const segmentLength = (bytes[offset]! << 8) | bytes[offset + 1]!;
    if (segmentLength < 2 || offset + segmentLength > bytes.length) return null;
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
      return {
        height: (bytes[offset + 3]! << 8) | bytes[offset + 4]!,
        width: (bytes[offset + 5]! << 8) | bytes[offset + 6]!,
      };
    }
    offset += segmentLength;
  }
  return null;
}

function webpDimensions(bytes: Uint8Array): { readonly width: number; readonly height: number } | null {
  const chunk = ascii(bytes, 12, 4);
  if (chunk === "VP8X" && bytes.length >= 30) {
    return {
      width: 1 + uint24(bytes, 24),
      height: 1 + uint24(bytes, 27),
    };
  }
  if (chunk === "VP8 " && bytes.length >= 30 && hasBytes(bytes, [0x9d, 0x01, 0x2a], 23)) {
    return {
      width: (bytes[26]! | (bytes[27]! << 8)) & 0x3fff,
      height: (bytes[28]! | (bytes[29]! << 8)) & 0x3fff,
    };
  }
  if (chunk === "VP8L" && bytes.length >= 25 && bytes[20] === 0x2f) {
    return {
      width: 1 + (bytes[21]! | ((bytes[22]! & 0x3f) << 8)),
      height: 1 + ((bytes[22]! >> 6) | (bytes[23]! << 2) | ((bytes[24]! & 0x0f) << 10)),
    };
  }
  return null;
}

function svgDimensions(svg: string): { readonly width: number; readonly height: number } | null {
  const root = /^\s*(?:<\?xml[^>]*>\s*)?<svg\b([^>]*)>/iu.exec(svg)?.[1];
  if (!root) return null;
  const width = numericSvgAttribute(root, "width");
  const height = numericSvgAttribute(root, "height");
  if (width && height) return { width, height };
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

export function validateImageDimensions(dimensions: { readonly width: number; readonly height: number }): void {
  if (!Number.isFinite(dimensions.width) || !Number.isFinite(dimensions.height) || dimensions.width <= 0 || dimensions.height <= 0 || dimensions.width > MAX_IMAGE_DIMENSION || dimensions.height > MAX_IMAGE_DIMENSION || dimensions.width * dimensions.height * 4 > MAX_DECODED_IMAGE_BYTES) {
    throw new Error("whiteboard image dimensions exceed the decoded-memory limit");
  }
}

function validateSvg(svg: string): void {
  if (
    !/^\s*(?:<\?xml[^>]*>\s*)?<svg(?:\s|>)/iu.test(svg) ||
    /<!DOCTYPE|<!ENTITY/iu.test(svg) ||
    /<(?:script|foreignObject|iframe|object|embed|audio|video|use|image)\b/iu.test(svg) ||
    /\bon[a-z]+\s*=/iu.test(svg) ||
    /\b(?:href|src)\s*=\s*["']?\s*(?:https?:|\/\/|javascript:)/iu.test(svg) ||
    /\burl\(\s*["']?\s*(?:https?:|\/\/|javascript:)/iu.test(svg)
  ) {
    throw new Error("whiteboard SVG contains unsafe external or executable content");
  }
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
