import { describe, expect, it } from "vitest";

import { ProviderError, providerSchemaFields } from "../src/errors.js";
import { DeepInfraWhisperProvider } from "../src/providers.js";
import type { ProviderPolicy } from "../src/types.js";

const policy: ProviderPolicy = {
  timeoutMs: 1000,
  maxAudioBytes: 1024,
  maxAudioSeconds: 900,
  maxResponseBytes: 4096,
  maxTextChars: 1024,
  maxSegments: 100,
  maxWords: 100,
  maxRetries: 0,
  retryBaseDelayMs: 1,
  retryMaxDelayMs: 1,
  circuitFailureThreshold: 5,
  circuitCooldownMs: 1000,
};
const payload = {
  text: "PRIVATE_TRANSCRIPT",
  segments: [{ start: 0, end: 1, text: "PRIVATE_TRANSCRIPT" }],
  words: [{ start: 0, end: 1, text: "PRIVATE_TRANSCRIPT" }],
  request_id: "request-123",
};

async function failure(body: unknown, headers?: HeadersInit): Promise<ProviderError> {
  const provider = new DeepInfraWhisperProvider({ policy, token: "PRIVATE_TOKEN", fetch: async () => Response.json(body, { headers }) });
  try {
    await provider.transcribe({ audio: new Uint8Array([1, 2]), contentType: "audio/flac", chunkId: "chunk-1" });
  } catch (error) {
    if (error instanceof ProviderError) return error;
    throw error;
  }
  throw new Error("expected a schema failure");
}

describe("content-free provider schema diagnostics", () => {
  it.each([
    { body: { ...payload, segments: [{ start: 0, end: "PRIVATE_VALUE", text: "PRIVATE_TRANSCRIPT" }] }, path: "segments[0].end", expected: "finite nonnegative number", actual: "string" },
    { body: { ...payload, words: [{ start: 0, end: 0, text: "PRIVATE_TRANSCRIPT" }] }, path: "words[0].end", expected: "number greater than start", actual: "number" },
    { body: { ...payload, words: [{ start: 0, end: 1, text: { secret: "PRIVATE_VALUE" } }] }, path: "words[0].text", expected: "bounded string", actual: "object" },
    { body: { ...payload, inference_status: { cost: "PRIVATE_VALUE" } }, path: "inference_status.cost", expected: "finite number in [0, 1000]", actual: "string" },
  ])("reports $path without logging response values", async ({ body, path, expected, actual }) => {
    const error = await failure(body);
    expect(error.kind).toBe("schema");
    const fields = providerSchemaFields(error);
    expect(fields).toEqual({ fieldPath: path, expectedType: expected, actualType: actual, responseSizeBytes: new TextEncoder().encode(JSON.stringify(body)).byteLength, providerRequestId: "request-123" });
    expect(JSON.stringify(fields)).not.toContain("PRIVATE");
  });

  it("uses a bounded request ID header when the native request ID is null", async () => {
    const error = await failure({ ...payload, request_id: null, words: false }, { "x-request-id": "request-header-123" });
    expect(providerSchemaFields(error)).toMatchObject({ fieldPath: "words", expectedType: "array", actualType: "boolean", providerRequestId: "request-header-123" });
  });

  it.each(["PRIVATE TRANSCRIPT", "x".repeat(129), { secret: "PRIVATE_VALUE" }])("does not log malformed request IDs", async (requestId) => {
    const error = await failure({ ...payload, request_id: requestId, words: false });
    expect(providerSchemaFields(error).providerRequestId).toBe("unavailable");
    expect(JSON.stringify(providerSchemaFields(error))).not.toContain("PRIVATE");
  });

  it("reports non-JSON response bytes without including their content", async () => {
    const body = "PRIVATE_RESPONSE";
    const provider = new DeepInfraWhisperProvider({ policy, token: "PRIVATE_TOKEN", fetch: async () => new Response(body, { headers: { "x-request-id": "request-123" } }) });
    await expect(provider.transcribe({ audio: new Uint8Array([1]), contentType: "audio/flac", chunkId: "chunk-1" })).rejects.toMatchObject({ schemaFailure: { fieldPath: "$", expectedType: "JSON", actualType: "string", responseSizeBytes: body.length, providerRequestId: "request-123" } });
  });

  it("reports oversized response bounds and header identity without parsing the body", async () => {
    const provider = new DeepInfraWhisperProvider({ policy, token: "PRIVATE_TOKEN", fetch: async () => new Response("PRIVATE_RESPONSE", { headers: { "content-length": "5000", "x-request-id": "request-123" } }) });
    await expect(provider.transcribe({ audio: new Uint8Array([1]), contentType: "audio/flac", chunkId: "chunk-1" })).rejects.toMatchObject({ schemaFailure: { fieldPath: "$", expectedType: "bounded response bytes", actualType: "number", responseSizeBytes: 5000, providerRequestId: "request-123" } });
  });
});
