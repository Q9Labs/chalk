import type { AppState, BinaryFileData, BinaryFiles, WhiteboardJsonValue, WhiteboardWireElement } from "@q9labsai/chalk-whiteboard";

const RECORDING_WHITEBOARD_STATE_KEYS = ["schemaVersion", "sceneId", "revision", "appState", "elements"] as const;
const RECORDING_WHITEBOARD_APP_STATE_KEYS = ["view_background_color"] as const;
const WHITEBOARD_WIRE_ELEMENT_KEYS = ["id", "type", "version", "version_nonce", "index", "is_deleted", "payload"] as const;
const MAX_VIEW_BACKGROUND_COLOR_BYTES = 64;
const EXCALIDRAW_FILE_MIME_TYPES = new Set(["image/svg+xml", "image/png", "image/jpeg", "image/gif", "image/webp", "image/bmp", "image/x-icon", "image/avif", "image/jfif", "application/octet-stream"]);

interface RecordingWhiteboardStateInput {
  readonly schemaVersion: unknown;
  readonly sceneId: unknown;
  readonly revision: unknown;
  readonly appState: unknown;
  readonly elements: unknown;
}

interface WhiteboardWireElementInput {
  readonly id: unknown;
  readonly type: unknown;
  readonly version: unknown;
  readonly version_nonce: unknown;
  readonly index: unknown;
  readonly is_deleted: unknown;
  readonly payload: unknown;
}

export interface RecordingWhiteboardAppStateV1 {
  readonly view_background_color?: string;
}

export interface RecordingWhiteboardStateV1 {
  readonly schemaVersion: "recording_whiteboard_state.v1";
  readonly sceneId: string;
  readonly revision: number;
  readonly appState: RecordingWhiteboardAppStateV1;
  readonly elements: readonly WhiteboardWireElement[];
}

export interface RecordingWhiteboardBinaryFileInput {
  readonly fileId: string;
  readonly mimeType: string;
  readonly dataURL: string;
  readonly createdAtMs?: number;
}

export interface RecordingWhiteboardFileReference {
  readonly fileId: string;
  readonly assetId: string;
}

export type RecordingWhiteboardFileResolver = (reference: RecordingWhiteboardFileReference) => Promise<Omit<RecordingWhiteboardBinaryFileInput, "fileId">>;

/** Validates the canonical asset before any value reaches Excalidraw. */
export function parseRecordingWhiteboardStateV1(value: unknown): RecordingWhiteboardStateV1 {
  if (!isRecordingWhiteboardStateInput(value)) throw invalidState();
  if (value.schemaVersion !== "recording_whiteboard_state.v1" || !isNonEmptyString(value.sceneId) || !isNonNegativeSafeInteger(value.revision)) throw invalidState();
  const appState = parseRecordingWhiteboardAppState(value.appState);
  if (!Array.isArray(value.elements) || !value.elements.every(isWhiteboardWireElement)) throw invalidState();
  if (!isCanonicalElementOrder(value.elements)) throw new TypeError("recording whiteboard elements are not in canonical order");
  return Object.freeze({
    schemaVersion: value.schemaVersion,
    sceneId: value.sceneId,
    revision: value.revision,
    appState,
    elements: Object.freeze([...value.elements]),
  });
}

export function recordingWhiteboardFileIds(state: RecordingWhiteboardStateV1): readonly string[] {
  const ids = new Set<string>();
  for (const element of state.elements) {
    if (element.is_deleted) continue;
    const fileId = element.payload.fileId;
    if (isNonEmptyString(fileId)) ids.add(fileId);
  }
  return Object.freeze([...ids].sort());
}

export function recordingWhiteboardFileAssetId(fileId: string): string {
  if (!isNonEmptyString(fileId)) throw new TypeError("recording whiteboard file id is invalid");
  return `whiteboard_file:${fileId}`;
}

export function recordingWhiteboardSceneAppState(state: RecordingWhiteboardStateV1, defaultViewBackgroundColor: string): Pick<AppState, "viewBackgroundColor"> {
  return Object.freeze({ viewBackgroundColor: state.appState.view_background_color ?? defaultViewBackgroundColor });
}

/** Centralizes validation and branding so renderer callers never cast file data. */
export function recordingWhiteboardBinaryFile({ fileId, mimeType, dataURL, createdAtMs = 0 }: RecordingWhiteboardBinaryFileInput): BinaryFileData {
  if (!isRecordingWhiteboardFileId(fileId) || !isNonNegativeSafeInteger(createdAtMs)) throw new TypeError("recording whiteboard file is invalid");
  const normalizedMimeType = normalizedFileMimeType(mimeType);
  if (!isRecordingWhiteboardDataURL(dataURL, normalizedMimeType)) throw new TypeError("recording whiteboard file data URL is invalid");
  return Object.freeze({ id: fileId, mimeType: normalizedMimeType, dataURL, created: createdAtMs });
}

export async function loadRecordingWhiteboardFiles(state: RecordingWhiteboardStateV1, resolve: RecordingWhiteboardFileResolver): Promise<BinaryFiles> {
  const pairs = await Promise.all(
    recordingWhiteboardFileIds(state).map(async (fileId) => {
      const source = await resolve(Object.freeze({ fileId, assetId: recordingWhiteboardFileAssetId(fileId) }));
      return [fileId, recordingWhiteboardBinaryFile({ fileId, ...source })] as const;
    }),
  );
  const files: BinaryFiles = {};
  for (const [fileId, file] of pairs) files[fileId] = file;
  return Object.freeze(files);
}

function isRecordingWhiteboardStateInput(value: unknown): value is RecordingWhiteboardStateInput {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  return hasExactKeys(value, RECORDING_WHITEBOARD_STATE_KEYS);
}

function isWhiteboardWireElement(value: unknown): value is WhiteboardWireElement {
  if (!isWhiteboardWireElementInput(value)) return false;
  return isNonEmptyString(value.id) && isNonEmptyString(value.type) && isNonNegativeSafeInteger(value.version) && isNonNegativeSafeInteger(value.version_nonce) && isNonEmptyString(value.index) && typeof value.is_deleted === "boolean" && isWhiteboardElementPayload(value.payload);
}

function isWhiteboardWireElementInput(value: unknown): value is WhiteboardWireElementInput {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  return hasExactKeys(value, WHITEBOARD_WIRE_ELEMENT_KEYS);
}

function hasExactKeys(value: object, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function isCanonicalElementOrder(elements: readonly WhiteboardWireElement[]): boolean {
  let previous: WhiteboardWireElement | undefined;
  for (const current of elements) {
    if (previous === undefined) {
      previous = current;
      continue;
    }
    if (previous.index > current.index || (previous.index === current.index && previous.id > current.id)) return false;
    previous = current;
  }
  return true;
}

function parseRecordingWhiteboardAppState(value: unknown): RecordingWhiteboardAppStateV1 {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw invalidState();
  const keys = Object.keys(value);
  if (keys.length === 0) return Object.freeze({});
  if (!hasExactKeys(value, RECORDING_WHITEBOARD_APP_STATE_KEYS) || !("view_background_color" in value) || !isViewBackgroundColor(value.view_background_color)) throw invalidState();
  return Object.freeze({ view_background_color: value.view_background_color });
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function normalizedFileMimeType(value: string): BinaryFileData["mimeType"] {
  const [rawMimeType] = value.split(";", 1);
  const mimeType = rawMimeType?.trim().toLowerCase();
  if (!mimeType || !isRecordingWhiteboardFileMimeType(mimeType)) throw new TypeError("recording whiteboard file MIME type is unsupported");
  return mimeType;
}

function isRecordingWhiteboardDataURL(value: string, mimeType: BinaryFileData["mimeType"]): value is BinaryFileData["dataURL"] {
  if (!value.startsWith("data:") || !value.includes(",")) return false;
  const encodedMimeType = value.slice(5, value.indexOf(",")).split(";", 1)[0]?.trim().toLowerCase();
  return encodedMimeType === mimeType;
}

function isRecordingWhiteboardFileId(value: string): value is BinaryFileData["id"] {
  return isNonEmptyString(value);
}

function isRecordingWhiteboardFileMimeType(value: string): value is BinaryFileData["mimeType"] {
  return EXCALIDRAW_FILE_MIME_TYPES.has(value);
}

function isViewBackgroundColor(value: unknown): value is string {
  return typeof value === "string" && new TextEncoder().encode(value).byteLength <= MAX_VIEW_BACKGROUND_COLOR_BYTES;
}

function isWhiteboardElementPayload(value: unknown): value is WhiteboardWireElement["payload"] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  return Object.values(value).every((item) => isWhiteboardJsonValue(item, 0));
}

function isWhiteboardJsonValue(value: unknown, depth: number): value is WhiteboardJsonValue {
  if (depth > 16) return false;
  if (value === null || typeof value === "boolean" || typeof value === "string") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every((item) => isWhiteboardJsonValue(item, depth + 1));
  if (typeof value !== "object") return false;
  return Object.values(value).every((item) => isWhiteboardJsonValue(item, depth + 1));
}

function invalidState(): TypeError {
  return new TypeError("recording whiteboard state is invalid");
}
