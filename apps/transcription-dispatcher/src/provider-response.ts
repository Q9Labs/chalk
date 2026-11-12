import { BodyTooLargeError, readBoundedBody } from "./bounded-body.js";
import { ProviderError, providerSchemaError, providerSchemaFields } from "./errors.js";
import type { ProviderRequest, ProviderResult, ProviderSegment, ProviderWord } from "./provider-types.js";

export async function parseProviderResponse(response: Response, maxBytes: number, parse: (body: unknown) => ProviderResult): Promise<ProviderResult> {
  let size = 0;
  let body: unknown;
  try {
    const bytes = await readProviderBody(response, maxBytes);
    size = bytes.byteLength;
    body = parseJson(bytes);
    return parse(body);
  } catch (error) {
    if (error instanceof ProviderError && error.kind === "schema") {
      const fields = providerSchemaFields(error);
      error.schemaFailure = { ...fields, responseSizeBytes: size || fields.responseSizeBytes, providerRequestId: responseRequestId(response, body) };
    }
    throw error;
  }
}

function responseRequestId(response: Response, body: unknown): string {
  const result = typeof body === "object" && body !== null && "result" in body ? body.result : undefined;
  const candidates = [...requestIds(body), ...requestIds(result), response.headers.get("x-request-id"), response.headers.get("request-id")];
  // Only bounded identifier characters, never arbitrary response strings.
  for (const candidate of candidates) {
    if (typeof candidate === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/u.test(candidate)) return candidate;
  }
  return "unavailable";
}

function requestIds(body: unknown): unknown[] {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return [];
  return ["request_id" in body ? body.request_id : undefined, "requestId" in body ? body.requestId : undefined];
}

export async function readProviderBody(response: Response, maxBytes: number): Promise<Uint8Array> {
  try {
    return await readBoundedBody(response, maxBytes);
  } catch (error) {
    if (!(error instanceof BodyTooLargeError)) throw error;
    throw providerSchemaError("provider response exceeded bound", "$", "bounded response bytes", error.observedBytes, error.observedBytes);
  }
}

export function parseJson(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    throw providerSchemaError("provider response was not JSON", "$", "JSON", "", bytes.byteLength);
  }
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw providerSchemaError(`${label} is invalid`, label, "object", value);
  return value as Record<string, unknown>;
}

function string(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== "string" || value.length > maxLength) throw providerSchemaError(`${label} is invalid`, label, "bounded string", value);
  return value;
}

function finite(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw providerSchemaError(`${label} is invalid`, label, "finite nonnegative number", value);
  return value;
}

function confidence(value: unknown, label: string): number {
  const number = finite(value, label);
  if (number > 1) throw providerSchemaError(`${label} is invalid`, label, "number in [0, 1]", value);
  return number;
}

function optionalFinite(value: unknown, label: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  return finite(value, label);
}

interface ParseLimits {
  maxTextChars: number;
  maxSegments: number;
  maxWords: number;
  maxAudioSeconds: number;
  onTimingRepair?: ProviderRequest["onTimingRepair"];
}

function confidenceField(value: unknown, label: string): { confidence?: number } {
  return value === undefined ? {} : { confidence: confidence(value, label) };
}

function optionalString(value: unknown, label: string, maxLength: number): string | undefined {
  return value === undefined || value === null ? undefined : string(value, label, maxLength);
}

function parseSegments(value: unknown, limits: ParseLimits): ProviderSegment[] {
  if (!Array.isArray(value) || value.length > limits.maxSegments) throw providerSchemaError("provider timings are required", "segments", "bounded array", value);
  const segments: ProviderSegment[] = [];
  for (const [index, item] of value.entries()) {
    let segment = parseSegment(item, index, limits);
    for (let previous = segments.at(-1); previous && segment.startSeconds < previous.endSeconds; previous = segments.at(-1)) {
      limits.onTimingRepair?.({ fieldPath: `segments[${index}].start`, startSeconds: segment.startSeconds, endSeconds: segment.endSeconds, previousEndSeconds: previous.endSeconds });
      segment = unionSegments(previous, segment, `segments[${index}].text`, limits.maxTextChars);
      segments.pop();
    }
    segments.push(segment);
  }
  return segments;
}

function parseSegment(item: unknown, index: number, limits: ParseLimits): ProviderSegment {
  const row = object(item, `segments[${index}]`);
  const startSeconds = finite(row.start, `segments[${index}].start`);
  const endSeconds = finite(row.end, `segments[${index}].end`);
  if (endSeconds < startSeconds) {
    const error = providerSchemaError("segment timing is invalid", `segments[${index}].end`, "number at or after start", row.end);
    error.schemaFailure = { ...providerSchemaFields(error), startSeconds, endSeconds };
    throw error;
  }
  if (endSeconds > limits.maxAudioSeconds) throw providerSchemaError("provider timing exceeded bound", `segments[${index}].end`, "bounded audio seconds", endSeconds);
  const zeroLength = endSeconds === startSeconds;
  if (zeroLength) limits.onTimingRepair?.({ fieldPath: `segments[${index}].end`, startSeconds, endSeconds });
  return {
    // Extend a zero-length segment backward so text at the actual chunk end survives clipping.
    startSeconds: zeroLength ? Math.max(0, startSeconds - 0.001) : startSeconds,
    endSeconds: zeroLength ? Math.max(endSeconds, 0.001) : endSeconds,
    text: string(row.text, `segments[${index}].text`, limits.maxTextChars),
    ...(zeroLength ? { useSegmentText: true } : {}),
    ...confidenceField(row.confidence, `segments[${index}].confidence`),
  };
}

/** Partial word timings cannot account for all text in the union, so the merged segment keeps its own text. */
function unionSegments(previous: ProviderSegment, segment: ProviderSegment, textLabel: string, maxTextChars: number): ProviderSegment {
  return {
    startSeconds: Math.min(previous.startSeconds, segment.startSeconds),
    endSeconds: Math.max(previous.endSeconds, segment.endSeconds),
    text: string(`${previous.text} ${segment.text}`, textLabel, maxTextChars),
    useSegmentText: true,
    ...(previous.confidence === undefined && segment.confidence === undefined ? {} : { confidence: Math.min(previous.confidence ?? 1, segment.confidence ?? 1) }),
  };
}

function parseWords(value: unknown, limits: ParseLimits): ProviderWord[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.length > limits.maxWords) throw providerSchemaError("provider words are invalid", "words", "bounded array", value);
  return value.map((item, index) => {
    const row = object(item, `words[${index}]`);
    const startSeconds = finite(row.start, `words[${index}].start`);
    const endSeconds = finite(row.end, `words[${index}].end`);
    if (endSeconds <= startSeconds) throw providerSchemaError("word timing is invalid", `words[${index}].end`, "number greater than start", row.end);
    if (endSeconds > limits.maxAudioSeconds) throw providerSchemaError("provider word timing exceeded bound", `words[${index}].end`, "bounded audio seconds", endSeconds);
    return { startSeconds, endSeconds, word: string(row.word, `words[${index}].word`, limits.maxTextChars), ...confidenceField(row.confidence, `words[${index}].confidence`) };
  });
}

export function parseProviderResult(value: unknown, options: ParseLimits & { provider: ProviderResult["provider"]; model: string; versionContract: string; executionIdentity?: string }): ProviderResult {
  const row = object(value, "$");
  const text = string(row.text, "text", options.maxTextChars);
  const segments = parseSegments(row.segments, options);
  const words = parseWords(row.words, options);
  if (segments.length === 0 && (text.trim().length > 0 || (words?.length ?? 0) > 0)) {
    throw providerSchemaError("provider content requires segment timings", "segments", "nonempty array when transcript content is present", row.segments);
  }
  const durationSeconds = optionalFinite(row.duration, "duration");
  if (durationSeconds !== undefined && durationSeconds > options.maxAudioSeconds) throw providerSchemaError("provider duration exceeded bound", "duration", "bounded audio seconds", row.duration);
  const language = optionalString(row.language, "language", 64);
  const providerIdentity = parseIdentity(row);
  return {
    text,
    ...(language === undefined ? {} : { language }),
    ...(durationSeconds === undefined ? {} : { durationMs: Math.round(durationSeconds * 1_000) }),
    segments,
    ...(words === undefined ? {} : { words }),
    provider: options.provider,
    model: options.model,
    versionContract: options.versionContract,
    ...(options.executionIdentity === undefined ? {} : { executionIdentity: options.executionIdentity }),
    ...(providerIdentity === undefined ? {} : { providerIdentity }),
    quality: qualityOf(segments, words),
  };
}

function qualityOf(segments: readonly ProviderSegment[], words: readonly ProviderWord[] | undefined): NonNullable<ProviderResult["quality"]> {
  const confidences = segments.flatMap((segment) => segment.confidence ?? []);
  return {
    ...(confidences.length === 0 ? {} : { meanConfidence: confidences.reduce((sum, value) => sum + value, 0) / confidences.length }),
    segmentCount: segments.length,
    wordCount: words?.length || segments.reduce((count, segment) => count + (segment.text.trim().match(/\S+/gu)?.length ?? 0), 0),
  };
}

function identityString(value: unknown, field: string, message: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw providerSchemaError(message, field, "string", value);
  return value;
}

function parseIdentity(row: Record<string, unknown>): ProviderResult["providerIdentity"] {
  const requestIdField = row.request_id != null ? "request_id" : "requestId";
  const requestId = identityString(row[requestIdField], requestIdField, "provider request identity is invalid");
  const model = identityString(row.model, "model", "provider model identity is invalid");
  if (requestId === undefined && model === undefined) return undefined;
  return {
    ...(requestId === undefined ? {} : { requestId }),
    ...(model === undefined ? {} : { model }),
  };
}
