import { ProviderError } from "./errors.js";
import type { ProviderRequest, ProviderResult, ProviderSegment, ProviderWord } from "./types.js";

export async function readBoundedBody(response: Response, maxBytes: number): Promise<Uint8Array> {
  const declared = response.headers.get("content-length");
  if (declared && Number(declared) > maxBytes) throw new ProviderError("provider response exceeded bound", "schema");
  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > maxBytes) throw new ProviderError("provider response exceeded bound", "schema");
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
      if (total > maxBytes) throw new ProviderError("provider response exceeded bound", "schema");
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
    throw new ProviderError("provider response was not JSON", "schema");
  }
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ProviderError(`${label} is invalid`, "schema");
  return value as Record<string, unknown>;
}

function string(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== "string" || value.length > maxLength) throw new ProviderError(`${label} is invalid`, "schema");
  return value;
}

function finite(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new ProviderError(`${label} is invalid`, "schema");
  return value;
}

function confidence(value: unknown, label: string): number {
  const number = finite(value, label);
  if (number > 1) throw new ProviderError(`${label} is invalid`, "schema");
  return number;
}

function optionalFinite(value: unknown, label: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  return finite(value, label);
}

function parseSegments(value: unknown, max: number, maxTextChars: number): ProviderSegment[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > max) throw new ProviderError("provider timings are required", "schema");
  let previousEnd = 0;
  return value.map((item, index) => {
    const row = object(item, `segment ${index}`);
    const startSeconds = finite(row.start, `segment ${index} start`);
    const endSeconds = finite(row.end, `segment ${index} end`);
    if (endSeconds <= startSeconds) throw new ProviderError("segment timing is invalid", "schema");
    if (startSeconds < previousEnd) throw new ProviderError("segment timings are not ordered", "schema");
    previousEnd = endSeconds;
    return {
      startSeconds,
      endSeconds,
      text: string(row.text, `segment ${index} text`, maxTextChars),
      ...(row.avg_logprob !== undefined ? {} : {}),
      ...(row.confidence !== undefined ? { confidence: confidence(row.confidence, `segment ${index} confidence`) } : {}),
    };
  });
}

function parseWords(value: unknown, max: number, maxTextChars: number): ProviderWord[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.length > max) throw new ProviderError("provider words are invalid", "schema");
  return value.map((item, index) => {
    const row = object(item, `word ${index}`);
    const startSeconds = finite(row.start, `word ${index} start`);
    const endSeconds = finite(row.end, `word ${index} end`);
    if (endSeconds <= startSeconds) throw new ProviderError("word timing is invalid", "schema");
    return {
      startSeconds,
      endSeconds,
      word: string(row.word, `word ${index}`, maxTextChars),
      ...(row.confidence !== undefined ? { confidence: confidence(row.confidence, `word ${index} confidence`) } : {}),
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
  const row = object(value, "provider response");
  const text = string(row.text, "provider text", options.maxTextChars);
  const segments = parseSegments(row.segments, options.maxSegments, options.maxTextChars);
  const words = parseWords(row.words, options.maxWords, options.maxTextChars);
  const durationSeconds = optionalFinite(row.duration, "provider duration");
  if (durationSeconds !== undefined && durationSeconds > options.maxAudioSeconds) throw new ProviderError("provider duration exceeded bound", "schema");
  for (const segment of segments) {
    if (segment.endSeconds > options.maxAudioSeconds) throw new ProviderError("provider timing exceeded bound", "schema");
  }
  for (const word of words ?? []) {
    if (word.endSeconds > options.maxAudioSeconds) throw new ProviderError("provider word timing exceeded bound", "schema");
  }
  const language = row.language === undefined || row.language === null ? undefined : string(row.language, "provider language", 64);
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
      wordCount: words?.length ?? 0,
    },
  };
}

function parseIdentity(row: Record<string, unknown>): ProviderResult["providerIdentity"] {
  const requestId = row.request_id ?? row.requestId;
  const model = row.model;
  if (requestId !== undefined && typeof requestId !== "string") throw new ProviderError("provider request identity is invalid", "schema");
  if (model !== undefined && typeof model !== "string") throw new ProviderError("provider model identity is invalid", "schema");
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
