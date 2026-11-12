import { readFile, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, relative, sep } from "node:path";

import { COMPOSE_REQUEST_VERSION, MAXIMUM_RECORDING_DURATION_MS, MAXIMUM_RENDER_FPS, MAXIMUM_RENDER_HEIGHT, MAXIMUM_RENDER_WIDTH } from "../generated/render-contract.js";
import { exactKeys, integerField as validatedIntegerField, literalField, objectValue, patternedStringField as validatedPatternedStringField, stringField as validatedStringField } from "../validation.js";

const MAXIMUM_REQUEST_BYTES = 64 << 10;

const SHA256_PATTERN = /^[0-9a-f]{64}$/;

export interface ComposeRequestV1 {
  readonly schemaVersion: typeof COMPOSE_REQUEST_VERSION;
  readonly recordingId: string;
  readonly episodeId: string;
  readonly workspaceDirectory: string;
  readonly presentationPath: string;
  readonly presentationSha256: string;
  readonly assetDirectory: string;
  readonly decodedMediaPath: string;
  readonly decodedMediaSha256: string;
  readonly width: number;
  readonly height: number;
  readonly fps: number;
  readonly durationMs: number;
}

export function parseComposeRequestV1(value: unknown): ComposeRequestV1 {
  const request = objectValue(value, "compose request request");
  exactKeys(request, ["schema_version", "recording_id", "episode_id", "workspace_directory", "presentation_path", "presentation_sha256", "asset_directory", "decoded_media_path", "decoded_media_sha256", "width", "height", "fps", "duration_ms"], "compose request request");
  literalField(request, "schema_version", COMPOSE_REQUEST_VERSION, "compose request schema_version is invalid");
  const workspaceDirectory = absolutePathField(request, "workspace_directory");
  const presentationPath = absolutePathField(request, "presentation_path");
  const assetDirectory = absolutePathField(request, "asset_directory");
  const decodedMediaPath = absolutePathField(request, "decoded_media_path");
  const width = requestIntegerField(request, "width", 2, MAXIMUM_RENDER_WIDTH);
  const height = requestIntegerField(request, "height", 2, MAXIMUM_RENDER_HEIGHT);
  const fps = requestIntegerField(request, "fps", 1, MAXIMUM_RENDER_FPS);
  const durationMs = requestIntegerField(request, "duration_ms", 1, MAXIMUM_RECORDING_DURATION_MS);
  if (width % 2 !== 0 || height % 2 !== 0) throw new TypeError("compose request dimensions must be even");
  return {
    schemaVersion: COMPOSE_REQUEST_VERSION,
    recordingId: requestStringField(request, "recording_id"),
    episodeId: requestStringField(request, "episode_id"),
    workspaceDirectory,
    presentationPath,
    presentationSha256: requestPatternedStringField(request, "presentation_sha256", SHA256_PATTERN),
    assetDirectory,
    decodedMediaPath,
    decodedMediaSha256: requestPatternedStringField(request, "decoded_media_sha256", SHA256_PATTERN),
    width,
    height,
    fps,
    durationMs,
  };
}

function absolutePathField(value: object, key: string): string {
  const candidate = requestStringField(value, key);
  if (!isAbsolute(candidate)) throw new TypeError(`compose request ${key} must be absolute`);
  return candidate;
}

const requestStringField = (value: object, key: string): string => validatedStringField(value, key, "compose request", 4_096);
const requestPatternedStringField = (value: object, key: string, pattern: RegExp): string => validatedPatternedStringField(value, key, pattern, "compose request", 4_096);
const requestIntegerField = (value: object, key: string, minimum: number, maximum: number): number => validatedIntegerField(value, key, minimum, maximum, "compose request");

export async function readComposeRequest(path: string): Promise<ComposeRequestV1> {
  const facts = await stat(path);
  if (!facts.isFile() || facts.size < 1 || facts.size > MAXIMUM_REQUEST_BYTES) throw new TypeError("compose request request exceeds its byte bound");
  const value: unknown = JSON.parse(await readFile(path, "utf8"));
  return parseComposeRequestV1(value);
}

export async function validateResultPath(path: string, workspace: string): Promise<void> {
  if (!isAbsolute(path)) throw new TypeError("compose request result path must be absolute");
  const [workspaceRoot, resultParent] = await Promise.all([realpath(workspace), realpath(dirname(path))]);
  const pathFromWorkspace = relative(workspaceRoot, resultParent);
  if (pathFromWorkspace === ".." || pathFromWorkspace.startsWith(`..${sep}`)) throw new TypeError("compose request result path escapes the attempt workspace");
}
