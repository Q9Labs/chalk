import type { OrderedExcalidrawElement } from "./types.js";

export type WhiteboardJsonValue = null | boolean | number | string | readonly WhiteboardJsonValue[] | { readonly [key: string]: WhiteboardJsonValue };

export interface WhiteboardWireElement {
  readonly id: string;
  readonly type: string;
  readonly version: number;
  readonly version_nonce: number;
  readonly index: string;
  readonly is_deleted: boolean;
  readonly payload: Readonly<Record<string, WhiteboardJsonValue>>;
}

export interface WhiteboardCommit {
  readonly operationId: string;
  readonly sceneId: string;
  readonly revision: string;
  readonly sceneGeneration?: string;
}

export interface WhiteboardUploadInstructions {
  readonly uploadId: string;
  readonly method: "PUT";
  readonly uploadUrl: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly expiresAt: string;
}

const wireElementKeys = ["id", "type", "version", "version_nonce", "index", "is_deleted", "payload"] as const;
const wireElementValidators = [
  (value: Record<string, unknown>) => isNonEmptyString(value.id),
  (value: Record<string, unknown>) => isNonEmptyString(value.type),
  (value: Record<string, unknown>) => isNonNegativeSafeInteger(value.version),
  (value: Record<string, unknown>) => isNonNegativeSafeInteger(value.version_nonce),
  (value: Record<string, unknown>) => isNonEmptyString(value.index),
  (value: Record<string, unknown>) => typeof value.is_deleted === "boolean",
  (value: Record<string, unknown>) => isRecord(value.payload) && isJsonValue(value.payload),
] as const;

export function toWireElement(element: OrderedExcalidrawElement): WhiteboardWireElement {
  return {
    id: element.id,
    type: element.type,
    version: element.version,
    version_nonce: element.versionNonce,
    index: element.index,
    is_deleted: element.isDeleted,
    payload: toJsonRecord(element),
  };
}

export function fromWireElement(element: WhiteboardWireElement): OrderedExcalidrawElement {
  if (!isWireElement(element)) {
    throw new Error("invalid whiteboard-v1 element");
  }

  return {
    ...element.payload,
    id: element.id,
    type: element.type,
    version: element.version,
    versionNonce: element.version_nonce,
    index: element.index,
    isDeleted: element.is_deleted,
  } as unknown as OrderedExcalidrawElement;
}

export function isWireElement(value: unknown): value is WhiteboardWireElement {
  if (!isRecord(value) || !hasExactKeys(value, wireElementKeys)) {
    return false;
  }

  return wireElementValidators.every((validate) => validate(value));
}

function toJsonRecord(value: unknown): Readonly<Record<string, WhiteboardJsonValue>> {
  if (!isRecord(value)) throw new Error("Excalidraw element is not JSON serializable");
  return normalizeJsonRecord(value, 0);
}

function normalizeJsonRecord(value: Record<string, unknown>, depth: number): Readonly<Record<string, WhiteboardJsonValue>> {
  assertJsonDepth(depth);
  const entries: [string, WhiteboardJsonValue][] = [];
  for (const [key, item] of Object.entries(value)) {
    if (item === undefined) continue;
    entries.push([key, normalizeJsonValue(item, depth + 1)]);
  }
  return Object.fromEntries(entries);
}

function normalizeJsonValue(value: unknown, depth: number): WhiteboardJsonValue {
  assertJsonDepth(depth);
  if (Array.isArray(value)) return value.map((item) => normalizeJsonValue(item, depth + 1));
  if (isRecord(value)) return normalizeJsonRecord(value, depth);
  if (isJsonPrimitive(value)) return value;
  throw new Error("Excalidraw element is not JSON serializable");
}

function assertJsonDepth(depth: number): void {
  if (depth > 16) throw new Error("Excalidraw element is not JSON serializable");
}

function isJsonValue(value: unknown, depth = 0): value is WhiteboardJsonValue {
  if (depth > 16) return false;
  if (Array.isArray(value)) return value.every((item) => isJsonValue(item, depth + 1));
  if (isRecord(value)) return Object.values(value).every((item) => isJsonValue(item, depth + 1));
  return isJsonPrimitive(value);
}

function isJsonPrimitive(value: unknown): value is null | boolean | number | string {
  if (value === null) return true;
  if (typeof value === "number") return Number.isFinite(value);
  return typeof value === "boolean" || typeof value === "string";
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}
