import { describe, expect, it } from "vitest";

import { RecorderControlApiClient } from "../src/control-api.js";
import { AssignmentError, ProviderError } from "../src/errors.js";
import { normalizeTranscriptChunk } from "../src/normalize.js";
import { InvocationCircuit, transcribeWithFallback } from "../src/retry.js";
import { conditionalPutJson } from "../src/storage.js";
import type { ProviderPolicy, ProviderResult, TranscriptionAssignment, TranscriptionProvider } from "../src/types.js";
import { validateAssignment, validateSpeakerTurnManifest } from "../src/urls.js";

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const SHA_C = "c".repeat(64);

const assignment: TranscriptionAssignment = {
  jobId: "job-1",
  tenantId: "tenant-1",
  episodeId: "episode-1",
  recordingId: "recording-1",
  presentationSha256: SHA_C,
  sourceExpiresAt: "2030-01-01T00:00:00Z",
  attempt: 1,
  leaseToken: "lease-token",
  leaseExpiresAt: "2030-01-01T00:15:00Z",
  chunk: {
    chunkId: "chunk-1",
    inputObjectKey: "private/source-1.flac",
    chunkIndex: 0,
    generation: 7,
    inputUrl: "https://objects.example/chunk?X-Amz-Expires=900",
    inputUrlExpiresAt: "2030-01-01T00:15:00Z",
    inputContentType: "audio/flac",
    inputSizeBytes: 4_096,
    inputSha256: SHA_A,
    episodeStartMs: 10_000,
    episodeEndMs: 20_000,
    sourceStartMs: 2_000,
    sourceEndMs: 12_000,
    allocationId: "allocation-1",
    objectVersion: "",
    objectEtag: "etag-1",
    sourceIdentity: { kind: "participant", participantRef: "participant-1", participantGeneration: 3, trackId: "track-1", trackEpoch: "11" },
    sourceTrackClass: "microphone",
    displayNameSnapshot: "Speaker One",
    overlap: false,
  },
  manifest: {
    inputUrl: "https://objects.example/manifest?X-Amz-Expires=900",
    expiresAt: "2030-01-01T00:15:00Z",
    contentType: "application/json",
    sizeBytes: 8_192,
    sha256: SHA_B,
  },
  outputPutUrl: "https://objects.example/result?X-Amz-Expires=900",
  outputPutUrlExpiresAt: "2030-01-01T00:15:00Z",
  outputContentType: "application/json",
};

function sourceManifest(): Record<string, unknown> {
  return {
    schema_version: "recording-transcription-source.v1",
    tenant_id: "tenant-1",
    recording_id: "recording-1",
    episode_id: "episode-1",
    capture_epoch: 5,
    duration_ms: 20_000,
    timebase: "recording_relative_ms",
    presentation_sha256: SHA_C,
    producer: { render_job_id: "render-job-1", attempt_count: 2, fencing_generation: 7, envelope_sha256: SHA_B },
    chunk_policy: { version: "flac-16k-mono.v1", max_duration_ms: 900_000, context_ms: 2_000, codec: "flac", sample_rate_hz: 16_000, channels: 1 },
    chunks: [
      {
        chunk_id: "chunk-1",
        chunk_index: 0,
        generation: 7,
        participant_ref: "participant-1",
        participant_generation: 3,
        display_name_snapshot: "Speaker One",
        identity_kind: "participant",
        track_id: "track-1",
        track_epoch: "11",
        track_class: "microphone",
        start_ms: 10_000,
        end_ms: 20_000,
        source_start_ms: 2_000,
        source_end_ms: 12_000,
        overlap: false,
        storage: { allocation_id: "allocation-1", object_key: "private/source-1.flac", object_version: "", etag: "etag-1", content_type: "audio/flac", byte_size: 4_096, sha256: SHA_A },
      },
      {
        chunk_id: "chunk-2",
        chunk_index: 1,
        generation: 7,
        participant_ref: "participant-2",
        participant_generation: 4,
        display_name_snapshot: "Speaker Two",
        identity_kind: "participant",
        track_id: "track-2",
        track_epoch: "6",
        track_class: "microphone",
        start_ms: 10_000,
        end_ms: 20_000,
        source_start_ms: 0,
        source_end_ms: 10_000,
        overlap: true,
        storage: { allocation_id: "allocation-2", object_key: "private/source-2.flac", object_version: "version-2", etag: "etag-2", content_type: "audio/flac", byte_size: 4_100, sha256: SHA_B },
      },
    ],
  };
}

describe("recording transcription source contract", () => {
  it("uploads results without an unsigned x-amz checksum header", async () => {
    let headers = new Headers();
    const body = new TextEncoder().encode('{"text":"hello"}');
    await conditionalPutJson({
      fetch: (async (_input, init) => {
        headers = new Headers(init?.headers);
        return new Response(null, { status: 200 });
      }) as typeof fetch,
      url: "https://objects.example/result?X-Amz-Expires=900",
      body,
      checksumSha256: "a".repeat(64),
    });

    expect(headers.get("x-amz-checksum-sha256")).toBeNull();
    expect(headers.get("if-none-match")).toBe("*");
    expect(headers.get("content-length")).toBe(String(body.byteLength));
  });

  it("canonicalizes a snake_case control-plane job ID before validation", async () => {
    const control = new RecorderControlApiClient({
      baseUrl: "https://control.example",
      signer: { sign: () => ({}) },
      fetch: (async () => Response.json({ assignments: [{ ...assignment, jobId: undefined, job_id: assignment.jobId }] })) as typeof fetch,
    });

    const claim = await control.claim({ limit: 1, context: { journeyId: "11111111-1111-4111-8111-111111111111" } });

    expect(claim.assignments[0]?.jobId).toBe(assignment.jobId);
  });

  it("accepts an active job lease during the bounded post-window source grace", () => {
    const validated = validateAssignment({ ...assignment, sourceExpiresAt: "2020-01-01T00:00:00Z" });
    expect(validated.sourceExpiresAt).toBe("2020-01-01T00:00:00Z");
  });

  it("accepts only the committed snake_case manifest and preserves authenticated speaker provenance", () => {
    const manifest = validateSpeakerTurnManifest(sourceManifest(), assignment);
    expect(manifest.schemaVersion).toBe("recording-transcription-source.v1");
    expect(manifest.turns[0]?.identity).toEqual({ kind: "participant", participantRef: "participant-1", participantGeneration: 3, trackId: "track-1", trackEpoch: "11" });
  });

  it("rejects unknown schema fields and assignment/object fact mismatches", () => {
    const unknownField = { ...sourceManifest(), schemaVersion: "recording-transcription-source.v1" };
    expect(() => validateSpeakerTurnManifest(unknownField, assignment)).toThrow(AssignmentError);
    const mismatch = sourceManifest();
    const chunks = mismatch.chunks as Array<Record<string, unknown>>;
    const storage = chunks[0]?.storage as Record<string, unknown>;
    storage.allocation_id = "different-allocation";
    expect(() => validateSpeakerTurnManifest(mismatch, assignment)).toThrow(/does not match/);

    const keyMismatch = sourceManifest();
    const keyChunks = keyMismatch.chunks as Array<Record<string, unknown>>;
    const keyStorage = keyChunks[0]?.storage as Record<string, unknown>;
    keyStorage.object_key = "private/different.flac";
    expect(() => validateSpeakerTurnManifest(keyMismatch, assignment)).toThrow(/does not match/);
  });

  it("maps cropped audio time onto the recording and retains overlap without diarization", () => {
    const manifest = validateSpeakerTurnManifest(sourceManifest(), assignment);
    const provider: ProviderResult = {
      text: "hello",
      segments: [{ startSeconds: 2.5, endSeconds: 3.5, text: "hello", confidence: 0.9 }],
      provider: "deepinfra",
      model: "openai/whisper-large-v3-turbo",
      versionContract: "model-pin-1",
    };
    const document = normalizeTranscriptChunk({
      jobId: assignment.jobId,
      episodeId: assignment.episodeId,
      episodeStartMs: assignment.chunk.episodeStartMs,
      episodeEndMs: assignment.chunk.episodeEndMs,
      sourceStartMs: assignment.chunk.sourceStartMs,
      sourceEndMs: assignment.chunk.sourceEndMs,
      manifest,
      provider,
      attempt: assignment.attempt,
      measuredAudioMs: 10_000,
      sourceIdentity: assignment.chunk.sourceIdentity,
      sourceTrackClass: assignment.chunk.sourceTrackClass,
    });
    expect(document.cues).toEqual([expect.objectContaining({ startMs: 12_500, endMs: 13_500, displayNameSnapshot: "Speaker One", overlap: true, identity: assignment.chunk.sourceIdentity })]);
  });

  it.each([false, true])("retains cues from a later cropped chunk (word timings: %s)", (withWords) => {
    const manifest = validateSpeakerTurnManifest(sourceManifest(), assignment);
    const provider: ProviderResult = {
      text: "later speech",
      segments: [{ startSeconds: 1, endSeconds: 2, text: "later speech" }],
      ...(withWords ? { words: [{ startSeconds: 1.1, endSeconds: 1.8, word: "later speech" }] } : {}),
      provider: "deepinfra",
      model: "openai/whisper-large-v3-turbo",
      versionContract: "model-pin-1",
    };
    const document = normalizeTranscriptChunk({
      jobId: assignment.jobId,
      episodeId: assignment.episodeId,
      episodeStartMs: 310_000,
      episodeEndMs: 320_000,
      sourceStartMs: 300_000,
      sourceEndMs: 310_000,
      manifest: { ...manifest, turns: manifest.turns.map((turn) => ({ ...turn, startMs: turn.startMs + 300_000, endMs: turn.endMs + 300_000 })) },
      provider,
      attempt: assignment.attempt,
      measuredAudioMs: 10_000,
      sourceIdentity: assignment.chunk.sourceIdentity,
      sourceTrackClass: assignment.chunk.sourceTrackClass,
    });
    expect(document.cues).toEqual([expect.objectContaining({ startMs: withWords ? 311_100 : 311_000, endMs: withWords ? 311_800 : 312_000, text: "later speech", identity: assignment.chunk.sourceIdentity })]);
  });
});

describe("provider sequencing", () => {
  it("finishes a failed DeepInfra call before invoking the qualified Cloudflare fallback", async () => {
    const calls: string[] = [];
    const primary: TranscriptionProvider = {
      name: "deepinfra",
      transcribe: async () => {
        calls.push("deepinfra:start", "deepinfra:end");
        throw new ProviderError("unavailable", "retryable", { status: 503 });
      },
    };
    const fallback: TranscriptionProvider = {
      name: "cloudflare",
      transcribe: async () => {
        calls.push("cloudflare:start", "cloudflare:end");
        return { text: "ok", segments: [{ startSeconds: 0, endSeconds: 1, text: "ok" }], provider: "cloudflare", model: "@cf/openai/whisper-large-v3-turbo", versionContract: "qualified-1" };
      },
    };
    const policy: ProviderPolicy = { timeoutMs: 10_000, maxAudioBytes: 1024, maxAudioSeconds: 900, maxResponseBytes: 1024, maxTextChars: 1024, maxSegments: 100, maxWords: 100, maxRetries: 0, retryBaseDelayMs: 1, retryMaxDelayMs: 1, circuitFailureThreshold: 5, circuitCooldownMs: 1_000 };
    const result = await transcribeWithFallback({ primary, fallback, request: { audio: new Uint8Array([1]), contentType: "audio/flac", chunkId: "chunk-1" }, policy, circuit: new InvocationCircuit(5, 1_000), runtime: { sleep: async () => undefined, random: () => 0, now: () => 0 } });
    expect(result.usedFallback).toBe(true);
    expect(calls).toEqual(["deepinfra:start", "deepinfra:end", "cloudflare:start", "cloudflare:end"]);
  });
});
