import { ProviderError, providerSchemaError, providerSchemaFields } from "./errors.js";
import type { ProviderRequest, ProviderResult, ProviderSegment, ProviderWord } from "./types.js";

export async function parseProviderResponse(response: Response, maxBytes: number, parse: (body: unknown) => ProviderResult): Promise<ProviderResult> {
  let size = 0;
  let body: unknown;
  try {
    const bytes = await readBoundedBody(response, maxBytes);
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
  const bodyId = typeof body === "object" && body !== null && "request_id" in body ? body.request_id : undefined;
  const candidate = bodyId ?? response.headers.get("x-request-id") ?? response.headers.get("request-id");
  // Only bounded identifier characters, never arbitrary response strings.
  return typeof candidate === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/u.test(candidate) ? candidate : "unavailable";
}

export async function readBoundedBody(response: Response, maxBytes: number): Promise<Uint8Array> {
  const declared = response.headers.get("content-length");
  if (declared && Number(declared) > maxBytes) throw providerSchemaError("provider response exceeded bound", "$", "bounded response bytes", Number(declared), Number(declared));
  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > maxBytes) throw providerSchemaError("provider response exceeded bound", "$", "bounded response bytes", bytes.byteLength, bytes.byteLength);
    return bytes;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maxBytes) throw providerSchemaError("provider response exceeded bound", "$", "bounded response bytes", total, total);
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
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

function parseSegments(value: unknown, max: number, maxTextChars: number): ProviderSegment[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > max) throw providerSchemaError("provider timings are required", "segments", "nonempty bounded array", value);
  let previousEnd = 0;
  return value.map((item, index) => {
    const row = object(item, `segments[${index}]`);
    const startSeconds = finite(row.start, `segments[${index}].start`);
    const endSeconds = finite(row.end, `segments[${index}].end`);
    if (endSeconds <= startSeconds) throw providerSchemaError("segment timing is invalid", `segments[${index}].end`, "number greater than start", row.end);
    if (startSeconds < previousEnd) throw providerSchemaError("segment timings are not ordered", `segments[${index}].start`, "number at or after previous end", row.start);
    previousEnd = endSeconds;
    return {
      startSeconds,
      endSeconds,
      text: string(row.text, `segments[${index}].text`, maxTextChars),
      ...(row.confidence !== undefined ? { confidence: confidence(row.confidence, `segments[${index}].confidence`) } : {}),
    };
  });
}

function parseWords(value: unknown, max: number, maxTextChars: number): ProviderWord[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.length > max) throw providerSchemaError("provider words are invalid", "words", "bounded array", value);
  return value.map((item, index) => {
    const row = object(item, `words[${index}]`);
    const startSeconds = finite(row.start, `words[${index}].start`);
    const endSeconds = finite(row.end, `words[${index}].end`);
    if (endSeconds <= startSeconds) throw providerSchemaError("word timing is invalid", `words[${index}].end`, "number greater than start", row.end);
    return {
      startSeconds,
      endSeconds,
      word: string(row.word, `words[${index}].word`, maxTextChars),
      ...(row.confidence !== undefined ? { confidence: confidence(row.confidence, `words[${index}].confidence`) } : {}),
    };
  });
}

export function parseProviderResult(
  value: unknown,
  options: {
    provider: ProviderResult["provider"];
    model: string;
    versionContract: string;
    executionIdentity?: string;
    maxTextChars: number;
    maxSegments: number;
    maxWords: number;
    maxAudioSeconds: number;
  },
): ProviderResult {
  const row = object(value, "$");
  const text = string(row.text, "text", options.maxTextChars);
  const segments = parseSegments(row.segments, options.maxSegments, options.maxTextChars);
  const words = parseWords(row.words, options.maxWords, options.maxTextChars);
  const durationSeconds = optionalFinite(row.duration, "duration");
  if (durationSeconds !== undefined && durationSeconds > options.maxAudioSeconds) throw providerSchemaError("provider duration exceeded bound", "duration", "bounded audio seconds", row.duration);
  for (const [index, segment] of segments.entries()) {
    if (segment.endSeconds > options.maxAudioSeconds) throw providerSchemaError("provider timing exceeded bound", `segments[${index}].end`, "bounded audio seconds", segment.endSeconds);
  }
  for (const [index, word] of (words ?? []).entries()) {
    if (word.endSeconds > options.maxAudioSeconds) throw providerSchemaError("provider word timing exceeded bound", `words[${index}].end`, "bounded audio seconds", word.endSeconds);
  }
  const language = row.language === undefined || row.language === null ? undefined : string(row.language, "language", 64);
  const providerIdentity = parseIdentity(row);
  const confidenceValues = segments.flatMap((segment) => (segment.confidence === undefined ? [] : [segment.confidence]));
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
    quality: {
      ...(confidenceValues.length === 0 ? {} : { meanConfidence: confidenceValues.reduce((a, b) => a + b, 0) / confidenceValues.length }),
      segmentCount: segments.length,
      wordCount: words?.length || segments.reduce((count, segment) => count + (segment.text.trim().match(/\S+/gu)?.length ?? 0), 0),
    },
  };
}

function parseIdentity(row: Record<string, unknown>): ProviderResult["providerIdentity"] {
  const requestId = row.request_id ?? row.requestId ?? undefined;
  const model = row.model ?? undefined;
  if (requestId !== undefined && typeof requestId !== "string") throw providerSchemaError("provider request identity is invalid", row.request_id != null ? "request_id" : "requestId", "string", requestId);
  if (model !== undefined && typeof model !== "string") throw providerSchemaError("provider model identity is invalid", "model", "string", model);
  if (requestId === undefined && model === undefined) return undefined;
  return {
    ...(requestId === undefined ? {} : { requestId }),
    ...(model === undefined ? {} : { model }),
  };
}

export function classifyProviderStatus(status: number, provider: "deepinfra" | "cloudflare", code?: string): "retryable" | "nonretryable" {
  if (provider === "cloudflare") {
    if (status >= 500) return "retryable";
    if (status === 408 && (code === "3007" || code === "3008")) return "retryable";
    if (status === 429 && code === "3040") return "retryable";
    return "nonretryable";
  }
  if (status === 408 || status === 425 || status === 429 || status >= 500) return "retryable";
  return "nonretryable";
}

export function errorCodeFromBody(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const row = value as Record<string, unknown>;
  const result = row.errors;
  if (Array.isArray(result) && result[0] && typeof result[0] === "object") {
    const first = result[0] as Record<string, unknown>;
    return typeof first.code === "string" || typeof first.code === "number" ? String(first.code) : undefined;
  }
  const direct = row.code;
  return typeof direct === "string" || typeof direct === "number" ? String(direct) : undefined;
}

export function ensureAbortableTimeout(timeoutMs: number, signal?: AbortSignal): AbortSignal {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  if (signal) {
    if (signal.aborted) controller.abort();
    signal.addEventListener("abort", () => controller.abort(), { once: true });
  }
  controller.signal.addEventListener("abort", () => clearTimeout(timer), { once: true });
  return controller.signal;
}
