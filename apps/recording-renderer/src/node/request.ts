import { isAbsolute } from "node:path";

import { exactKeys, integerField as validatedIntegerField, literalField, objectValue, patternedStringField as validatedPatternedStringField, stringField as validatedStringField } from "../validation.js";

const FRAME_RENDER_REQUEST_VERSION = "recording-frame-render-request.v1";

const SHA256_PATTERN = /^[0-9a-f]{64}$/;

export interface FrameRenderRequestV1 {
  readonly schemaVersion: typeof FRAME_RENDER_REQUEST_VERSION;
  readonly recordingId: string;
  readonly episodeId: string;
  readonly workspaceDirectory: string;
  readonly presentationPath: string;
  readonly presentationSha256: string;
  readonly uiBuildSha256: string;
  readonly assetDirectory: string;
  readonly decodedMediaPath: string;
  readonly decodedMediaSha256: string;
  readonly width: number;
  readonly height: number;
  readonly fps: number;
  readonly durationMs: number;
}

export function parseFrameRenderRequestV1(value: unknown): FrameRenderRequestV1 {
  const request = objectValue(value, "frame render request");
  exactKeys(request, ["schema_version", "recording_id", "episode_id", "workspace_directory", "presentation_path", "presentation_sha256", "ui_build_sha256", "asset_directory", "decoded_media_path", "decoded_media_sha256", "width", "height", "fps", "duration_ms"], "frame render request");
  literalField(request, "schema_version", FRAME_RENDER_REQUEST_VERSION, "frame render schema_version is invalid");
  const workspaceDirectory = absolutePathField(request, "workspace_directory");
  const presentationPath = absolutePathField(request, "presentation_path");
  const assetDirectory = absolutePathField(request, "asset_directory");
  const decodedMediaPath = absolutePathField(request, "decoded_media_path");
  const width = requestIntegerField(request, "width", 2, 3_840);
  const height = requestIntegerField(request, "height", 2, 2_160);
  const fps = requestIntegerField(request, "fps", 1, 60);
  const durationMs = requestIntegerField(request, "duration_ms", 1, 7_200_000);
  if (width % 2 !== 0 || height % 2 !== 0) throw new TypeError("frame render dimensions must be even");
  return {
    schemaVersion: FRAME_RENDER_REQUEST_VERSION,
    recordingId: requestStringField(request, "recording_id"),
    episodeId: requestStringField(request, "episode_id"),
    workspaceDirectory,
    presentationPath,
    presentationSha256: requestPatternedStringField(request, "presentation_sha256", SHA256_PATTERN),
    uiBuildSha256: requestPatternedStringField(request, "ui_build_sha256", SHA256_PATTERN),
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
  if (!isAbsolute(candidate)) throw new TypeError(`frame render ${key} must be absolute`);
  return candidate;
}

const requestStringField = (value: object, key: string): string => validatedStringField(value, key, "frame render", 4_096);
const requestPatternedStringField = (value: object, key: string, pattern: RegExp): string => validatedPatternedStringField(value, key, pattern, "frame render", 4_096);
const requestIntegerField = (value: object, key: string, minimum: number, maximum: number): number => validatedIntegerField(value, key, minimum, maximum, "frame render");
