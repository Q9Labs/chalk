import { Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { createChalkEffectClient } from "./client";
import { RecordingIdSchema, TenantIdSchema, TranscriptSchema } from "./generated/schemas";

// Production Transcript list shape, with synthetic IDs, timestamps and artifact details.
const transcript = {
  id: "55555555-5555-4555-8555-555555555555",
  tenant_id: "11111111-1111-4111-8111-111111111111",
  recording_id: "44444444-4444-4444-8444-444444444444",
  space_id: "22222222-2222-4222-8222-222222222222",
  episode_id: "33333333-3333-4333-8333-333333333333",
  status: "complete",
  languages: ["en"],
  provider: "test-provider",
  model: "test-model",
  artifact_size: 1234,
  artifact_content_type: "application/json",
  source_expires_at: "2026-10-22T09:00:00Z",
  generation: 1,
  completed_at: "2026-10-02T09:00:00Z",
  updated_at: "2026-10-02T09:00:00Z",
  created_at: "2026-10-02T08:00:00Z",
};

const transcriptStatuses = ["not_requested", "preparing", "transcribing", "verifying", "complete", "retryable_failure", "terminal_failure", "deleted", "pending", "processing", "completed", "failed"];

describe("generated Transcript contract", () => {
  it("decodes the completed Transcript list loaded by Recording history", async () => {
    const response = { transcripts: [transcript], pagination: { page_size: 2, next_cursor: null, has_more: false } };
    const client = await Effect.runPromise(
      createChalkEffectClient({
        baseUrl: "https://chalk.test",
        fetch: async () => Response.json(response),
      }),
    );
    const result = await Effect.runPromise(
      client.transcripts.listTranscripts({
        params: { tenant_id: Schema.decodeUnknownSync(TenantIdSchema)(transcript.tenant_id) },
        query: { recording_id: Schema.decodeUnknownSync(RecordingIdSchema)(transcript.recording_id), page_size: 2 },
      }),
    );
    expect(result).toEqual(response);
  });

  it.each(transcriptStatuses)("accepts the supported Transcript state %s", (status) => {
    expect(Schema.decodeUnknownSync(TranscriptSchema)({ ...transcript, status }).status).toBe(status);
  });

  it("still rejects an unknown Transcript state", () => {
    expect(() => Schema.decodeUnknownSync(TranscriptSchema)({ ...transcript, status: "unknown" })).toThrow();
  });
});
