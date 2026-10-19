import { Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { createChalkEffectClient } from "./client";
import { RecordingIdSchema, SpaceIdSchema, TenantIdSchema, TranscriptSchema, UpdateSpaceRequestBodySchema } from "./generated/schemas";

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

  // Omitting languages asks the provider to detect them, so the engine accepts
  // the request and returns the new Transcript with an empty list.
  it("decodes the accepted response for a Transcript requested without languages", async () => {
    const accepted = { transcript: { ...transcript, status: "preparing", languages: [] }, job_id: "66666666-6666-4666-8666-666666666666", status: "pending" };
    const client = await Effect.runPromise(
      createChalkEffectClient({
        baseUrl: "https://chalk.test",
        fetch: async () => Response.json(accepted, { status: 202 }),
      }),
    );
    const result = await Effect.runPromise(
      client.transcripts.requestTranscript({
        params: { tenant_id: Schema.decodeUnknownSync(TenantIdSchema)(transcript.tenant_id), recording_id: Schema.decodeUnknownSync(RecordingIdSchema)(transcript.recording_id) },
        payload: { idempotency_key: "languages-omitted-0001" },
      }),
    );
    expect(result).toEqual(accepted);
  });

  it.each(transcriptStatuses)("accepts the supported Transcript state %s", (status) => {
    expect(Schema.decodeUnknownSync(TranscriptSchema)({ ...transcript, status }).status).toBe(status);
  });

  it("still rejects an unknown Transcript state", () => {
    expect(() => Schema.decodeUnknownSync(TranscriptSchema)({ ...transcript, status: "unknown" })).toThrow();
  });
});

// The API accepts a bare number or an omitted field for these durations and rejects an explicit null.
const spaceDurationFields = ["default_episode_duration_seconds", "maximum_episode_duration_seconds", "linger_window_seconds"] as const;

const space = {
  id: "22222222-2222-4222-8222-222222222222",
  tenant_id: "11111111-1111-4111-8111-111111111111",
  created_by_user_id: null,
  name: "Renamed",
  slug: "weekly-sync",
  media_plane: "cloudflare_sfu",
  recording_policy: "off",
  transcription_policy: "off",
  admission_policy: {},
  metadata: {},
  recurring_policy: {},
  roles: [],
  archived: false,
  default_episode_duration_seconds: 3600,
  maximum_episode_duration_seconds: 86400,
  linger_window_seconds: 300,
  created_at: "2026-10-02T08:00:00Z",
  updated_at: "2026-10-02T09:00:00Z",
};

describe("generated Space update contract", () => {
  const decodeUpdate = Schema.decodeUnknownSync(UpdateSpaceRequestBodySchema);

  it("renames a Space through the client with a name-only body", async () => {
    const bodies: unknown[] = [];
    const client = await Effect.runPromise(
      createChalkEffectClient({
        baseUrl: "https://chalk.test",
        fetch: async (input, init) => {
          bodies.push(await new Request(input, init).json());
          return Response.json(space);
        },
      }),
    );
    const result = await Effect.runPromise(
      client.spaces.updateSpace({
        params: { tenant_id: Schema.decodeUnknownSync(TenantIdSchema)(space.tenant_id), space_id: Schema.decodeUnknownSync(SpaceIdSchema)(space.id) },
        payload: { name: "Renamed" },
      }),
    );
    expect(bodies).toEqual([{ name: "Renamed" }]);
    expect(result.name).toBe("Renamed");
  });

  it("accepts a body that omits every duration", () => {
    expect(decodeUpdate({ name: "Renamed" })).toEqual({ name: "Renamed" });
  });

  it.each(spaceDurationFields)("accepts a number for %s", (field) => {
    expect(decodeUpdate({ [field]: 3600 })).toEqual({ [field]: 3600 });
  });

  it.each(spaceDurationFields)("rejects null for %s", (field) => {
    expect(() => decodeUpdate({ name: "Renamed", [field]: null })).toThrow();
  });

  it.each(spaceDurationFields)("rejects the internal {Set, Value} object for %s", (field) => {
    expect(() => decodeUpdate({ [field]: { Set: true, Value: 3600 } })).toThrow();
  });
});
