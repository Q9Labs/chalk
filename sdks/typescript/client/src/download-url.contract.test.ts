import { Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { createChalkEffectClient } from "./client";
import { RecordingDownloadURLSchema, RecordingIdSchema, TenantIdSchema, TranscriptDownloadURLSchema } from "./generated/schemas";

const download = {
  method: "GET",
  url: "https://storage.example.test/artifact",
  signed_at: "2031-02-03T04:05:06Z",
  expires_at: "2031-02-03T04:10:06Z",
};

for (const [name, schema] of [
  ["Recording", RecordingDownloadURLSchema],
  ["Transcript", TranscriptDownloadURLSchema],
] as const) {
  describe(`${name} download URL contract`, () => {
    const decode = Schema.decodeUnknownSync(schema);

    it.each([{}, { "Content-Type": ["application/octet-stream"] }])("accepts client headers %j", (headers) => {
      expect(decode({ ...download, signed_headers: headers }).signed_headers).toEqual(headers);
    });

    it.each([null, undefined, { "Content-Type": null }])("rejects nullable headers %j", (headers) => {
      expect(() => decode({ ...download, signed_headers: headers })).toThrow();
    });
  });
}

it("decodes a Recording download through the generated HTTP client", async () => {
  const client = await Effect.runPromise(createChalkEffectClient({ baseUrl: "https://chalk.test", fetch: async () => Response.json({ ...download, signed_headers: {} }) }));
  const response = await Effect.runPromise(
    client.recordings.createRecordingDownloadURL({
      params: { tenant_id: Schema.decodeUnknownSync(TenantIdSchema)("11111111-1111-4111-8111-111111111111"), recording_id: Schema.decodeUnknownSync(RecordingIdSchema)("44444444-4444-4444-8444-444444444444") },
      payload: { expires_in_seconds: 300 },
    }),
  );
  expect(response.signed_headers).toEqual({});
});
