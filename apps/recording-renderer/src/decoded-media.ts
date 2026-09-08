import { exactKeys, field, integerField as validatedIntegerField, literalField, objectValue, patternedStringField as validatedPatternedStringField, stringField as validatedStringField } from "./validation.js";

const DECODED_MEDIA_SCHEMA_VERSION = "decoded_media.v1";

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const SOURCE_ID_PATTERN = /^rps_[0-9a-f]{64}$/;
const DISCONTINUITY_REASONS: ReadonlySet<string> = new Set(["packet_loss", "source_gap", "attempt_recovery", "decode_failure"]);

export interface DecodedMediaClockV1 {
  readonly origin: "capture_ready";
  readonly timebase: "recording_relative_ms";
  readonly originAuthorityId: string;
  readonly captureEpoch: number;
  readonly durationMs: number;
}

interface DecodedMediaSourceBaseV1 {
  readonly sourceId: string;
  readonly participantId: string;
  readonly participantGeneration: number;
  readonly trackId: string;
  readonly trackEpoch: number;
  readonly codec: string;
  readonly container: string;
  readonly contentType: string;
  readonly path: string;
  readonly byteSize: number;
  readonly sha256: string;
  readonly startMs: number;
  readonly endMs: number;
}

export interface DecodedVisualSourceV1 extends DecodedMediaSourceBaseV1 {
  readonly kind: "camera" | "screen_share";
}

export interface DecodedMicrophoneSourceV1 extends DecodedMediaSourceBaseV1 {
  readonly kind: "microphone";
  readonly sampleRateHz: 48_000;
  readonly channels: 1;
}

export type DecodedMediaSourceV1 = DecodedVisualSourceV1 | DecodedMicrophoneSourceV1;

export interface DecodedAudioMixV1 {
  readonly path: string;
  readonly codec: "pcm_s16le";
  readonly container: "wav";
  readonly contentType: "audio/wav";
  readonly sampleRateHz: 48_000;
  readonly channels: 2;
  readonly byteSize: number;
  readonly sha256: string;
  readonly startMs: 0;
  readonly endMs: number;
}

export type DecodedMediaDiscontinuityReasonV1 = "packet_loss" | "source_gap" | "attempt_recovery" | "decode_failure";

export interface DecodedMediaDiscontinuityV1 {
  readonly sourceId: string;
  readonly trackId: string;
  readonly trackEpoch: number;
  readonly startMs: number;
  readonly endMs: number;
  readonly reason: DecodedMediaDiscontinuityReasonV1;
}

export interface DecodedMediaIndexV1 {
  readonly schemaVersion: typeof DECODED_MEDIA_SCHEMA_VERSION;
  readonly recordingId: string;
  readonly episodeId: string;
  readonly clock: DecodedMediaClockV1;
  readonly sources: readonly DecodedMediaSourceV1[];
  readonly mix: DecodedAudioMixV1;
  readonly discontinuities: readonly DecodedMediaDiscontinuityV1[];
}

export function parseDecodedMediaIndexV1(value: unknown): DecodedMediaIndexV1 {
  const root = objectValue(value, "decoded media index");
  exactKeys(root, ["schema_version", "recording_id", "episode_id", "clock", "sources", "mix", "discontinuities"], "decoded media object");
  decodedLiteralField(root, "schema_version", DECODED_MEDIA_SCHEMA_VERSION);
  const recordingId = stringField(root, "recording_id");
  const episodeId = stringField(root, "episode_id");
  const clock = decodeClock(field(root, "clock"));
  const sources = arrayValue(field(root, "sources"), "decoded media sources").map((source) => decodeSource(source, clock.durationMs));
  const mix = decodeMix(field(root, "mix"), clock.durationMs);
  const discontinuities = arrayValue(field(root, "discontinuities"), "decoded media discontinuities").map((item) => decodeDiscontinuity(item, clock.durationMs));
  assertUniqueSourceIds(sources);
  assertDiscontinuitiesBoundToSources(sources, discontinuities);
  return { schemaVersion: DECODED_MEDIA_SCHEMA_VERSION, recordingId, episodeId, clock, sources, mix, discontinuities };
}

function assertUniqueSourceIds(sources: readonly DecodedMediaSourceV1[]): void {
  const sourceIds = new Set<string>();
  for (const source of sources) {
    if (sourceIds.has(source.sourceId)) throw new TypeError(`duplicate decoded media source ${source.sourceId}`);
    sourceIds.add(source.sourceId);
  }
}

function assertDiscontinuitiesBoundToSources(sources: readonly DecodedMediaSourceV1[], discontinuities: readonly DecodedMediaDiscontinuityV1[]): void {
  const sourcesById = new Map(sources.map((source) => [source.sourceId, source]));
  for (const discontinuity of discontinuities) {
    const source = sourcesById.get(discontinuity.sourceId);
    if (!discontinuityIsBoundToSource(discontinuity, source)) {
      throw new TypeError(`decoded media discontinuity is not bound to source ${discontinuity.sourceId}`);
    }
  }
}

function discontinuityIsBoundToSource(discontinuity: DecodedMediaDiscontinuityV1, source: DecodedMediaSourceV1 | undefined): boolean {
  if (source === undefined) return false;
  return [source.trackId === discontinuity.trackId, source.trackEpoch === discontinuity.trackEpoch, discontinuity.startMs >= source.startMs, discontinuity.endMs <= source.endMs].every(Boolean);
}

function decodeClock(value: unknown): DecodedMediaClockV1 {
  const clock = objectValue(value, "decoded media clock");
  exactKeys(clock, ["origin", "timebase", "origin_authority_id", "capture_epoch", "duration_ms"], "decoded media object");
  decodedLiteralField(clock, "origin", "capture_ready");
  decodedLiteralField(clock, "timebase", "recording_relative_ms");
  return {
    origin: "capture_ready",
    timebase: "recording_relative_ms",
    originAuthorityId: stringField(clock, "origin_authority_id"),
    captureEpoch: integerField(clock, "capture_epoch", 1),
    durationMs: integerField(clock, "duration_ms", 1),
  };
}

function decodeSource(value: unknown, durationMs: number): DecodedMediaSourceV1 {
  const source = objectValue(value, "decoded media source");
  const kind = stringField(source, "kind");
  exactKeys(source, sourceKeys(kind), "decoded media object");
  const startMs = integerField(source, "start_ms", 0);
  const endMs = integerField(source, "end_ms", 1);
  assertInterval(startMs, endMs, durationMs, "decoded media source interval is invalid");
  const base = {
    sourceId: patternedStringField(source, "source_id", SOURCE_ID_PATTERN),
    participantId: stringField(source, "participant_id"),
    participantGeneration: integerField(source, "participant_generation", 1),
    trackId: stringField(source, "track_id"),
    trackEpoch: integerField(source, "track_epoch", 1),
    codec: stringField(source, "codec"),
    container: stringField(source, "container"),
    contentType: stringField(source, "content_type"),
    path: relativeArtifactPath(source, "path"),
    byteSize: integerField(source, "byte_size", 1),
    sha256: patternedStringField(source, "sha256", SHA256_PATTERN),
    startMs,
    endMs,
  };
  return decodeSourceKind(source, kind, base);
}

function sourceKeys(kind: string): readonly string[] {
  const commonKeys = ["source_id", "participant_id", "participant_generation", "track_id", "track_epoch", "kind", "codec", "container", "content_type", "path", "byte_size", "sha256", "start_ms", "end_ms"];
  return kind === "microphone" ? [...commonKeys, "sample_rate_hz", "channels"] : commonKeys;
}

function decodeSourceKind(source: object, kind: string, base: DecodedMediaSourceBaseV1): DecodedMediaSourceV1 {
  switch (kind) {
    case "camera":
    case "screen_share":
      return decodeVisualSource(kind, base);
    case "microphone":
      return decodeMicrophoneSource(source, base);
    default:
      throw new TypeError(`unsupported decoded media source kind ${kind}`);
  }
}

function decodeVisualSource(kind: "camera" | "screen_share", base: DecodedMediaSourceBaseV1): DecodedVisualSourceV1 {
  if (!base.contentType.startsWith("video/")) throw new TypeError("decoded visual source content type must be video");
  return { ...base, kind };
}

function decodeMicrophoneSource(source: object, base: DecodedMediaSourceBaseV1): DecodedMicrophoneSourceV1 {
  decodedLiteralField(source, "codec", "pcm_s16le");
  decodedLiteralField(source, "container", "wav");
  decodedLiteralField(source, "content_type", "audio/wav");
  literalNumberField(source, "sample_rate_hz", 48_000);
  literalNumberField(source, "channels", 1);
  return { ...base, kind: "microphone", codec: "pcm_s16le", container: "wav", contentType: "audio/wav", sampleRateHz: 48_000, channels: 1 };
}

function decodeMix(value: unknown, durationMs: number): DecodedAudioMixV1 {
  const mix = objectValue(value, "decoded audio mix");
  exactKeys(mix, ["path", "codec", "container", "content_type", "sample_rate_hz", "channels", "byte_size", "sha256", "start_ms", "end_ms"], "decoded media object");
  decodedLiteralField(mix, "codec", "pcm_s16le");
  decodedLiteralField(mix, "container", "wav");
  decodedLiteralField(mix, "content_type", "audio/wav");
  literalNumberField(mix, "sample_rate_hz", 48_000);
  literalNumberField(mix, "channels", 2);
  literalNumberField(mix, "start_ms", 0);
  literalNumberField(mix, "end_ms", durationMs);
  return {
    path: relativeArtifactPath(mix, "path"),
    codec: "pcm_s16le",
    container: "wav",
    contentType: "audio/wav",
    sampleRateHz: 48_000,
    channels: 2,
    byteSize: integerField(mix, "byte_size", 1),
    sha256: patternedStringField(mix, "sha256", SHA256_PATTERN),
    startMs: 0,
    endMs: durationMs,
  };
}

function decodeDiscontinuity(value: unknown, durationMs: number): DecodedMediaDiscontinuityV1 {
  const discontinuity = objectValue(value, "decoded media discontinuity");
  exactKeys(discontinuity, ["source_id", "track_id", "track_epoch", "start_ms", "end_ms", "reason"], "decoded media object");
  const startMs = integerField(discontinuity, "start_ms", 0);
  const endMs = integerField(discontinuity, "end_ms", 1);
  assertInterval(startMs, endMs, durationMs, "decoded media discontinuity interval is invalid");
  const reason = decodeDiscontinuityReason(discontinuity);
  return {
    sourceId: patternedStringField(discontinuity, "source_id", SOURCE_ID_PATTERN),
    trackId: stringField(discontinuity, "track_id"),
    trackEpoch: integerField(discontinuity, "track_epoch", 1),
    startMs,
    endMs,
    reason,
  };
}

function decodeDiscontinuityReason(discontinuity: object): DecodedMediaDiscontinuityReasonV1 {
  const reasonValue = stringField(discontinuity, "reason");
  if (!isDiscontinuityReason(reasonValue)) throw new TypeError(`unsupported decoded media discontinuity reason ${reasonValue}`);
  return reasonValue;
}

function isDiscontinuityReason(value: string): value is DecodedMediaDiscontinuityReasonV1 {
  return DISCONTINUITY_REASONS.has(value);
}

function assertInterval(startMs: number, endMs: number, durationMs: number, message: string): void {
  if (endMs <= startMs || endMs > durationMs) throw new TypeError(message);
}

function arrayValue(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array`);
  return value;
}

function stringField(value: object, key: string): string {
  return validatedStringField(value, key, "decoded media", 1_024);
}

function patternedStringField(value: object, key: string, pattern: RegExp): string {
  return validatedPatternedStringField(value, key, pattern, "decoded media", 1_024);
}

function integerField(value: object, key: string, minimum: number): number {
  return validatedIntegerField(value, key, minimum, Number.MAX_SAFE_INTEGER, "decoded media");
}

function literalNumberField(value: object, key: string, expected: number): void {
  decodedLiteralField(value, key, expected);
}

function decodedLiteralField<const Value extends string | number>(value: object, key: string, expected: Value): void {
  literalField(value, key, expected, `decoded media ${key} is not ${expected}`);
}

function relativeArtifactPath(value: object, key: string): string {
  const candidate = stringField(value, key);
  const segments = candidate.split("/");
  if (candidate.startsWith("/") || candidate.includes("\\") || segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new TypeError(`decoded media ${key} is not a normalized artifact-relative path`);
  }
  return candidate;
}
