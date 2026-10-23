import { Effect, Schema } from "effect";
import { createChalkEffectClient, RecordingSchema, TenantIdSchema } from "@q9labsai/chalk-client/effect";
import { expect, it } from "vitest";
import { listedRecording } from "./engine";

const id = (index: number) => `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
const date = "2026-10-22T12:00:00Z";
const recording = Schema.decodeUnknownSync(RecordingSchema)({
  id: id(1),
  tenant_id: id(2),
  space_id: id(3),
  episode_id: id(4),
  status: "completed",
  source: { status: "available" },
  export: { status: "ready", retryable: false },
  transcription_preparation: { status: "ready" },
  transcription_policy: "automatic",
  storage_provider: "r2",
  storage_key: null,
  metadata: {},
  created_at: date,
  updated_at: date,
});
const transcript = (index: number, status: string) => ({ id: id(index), tenant_id: id(2), space_id: id(3), episode_id: id(4), recording_id: id(1), generation: 1, status, languages: ["en"], created_at: date, updated_at: date });

it("follows the cursor past five failed or deleted rows to a completed transcript", async () => {
  const cursors: (string | null)[] = [];
  const api = await Effect.runPromise(
    createChalkEffectClient({
      baseUrl: "https://api.chalk.test",
      fetch: async (input) => {
        const cursor = new URL(String(input)).searchParams.get("cursor");
        cursors.push(cursor);
        const first = cursor === null;
        return Response.json({ pagination: { page_size: 5, has_more: true, next_cursor: first ? "older" : "oldest" }, transcripts: first ? Array.from({ length: 5 }, (_, index) => transcript(index + 10, index % 2 ? "deleted" : "failed")) : [transcript(20, "complete")] });
      },
    }),
  );
  const result = await listedRecording({ api, tenantId: Schema.decodeUnknownSync(TenantIdSchema)(id(2)), dashboardOrigin: "https://chalk.test" }, recording);
  expect(cursors).toEqual([null, "older"]);
  expect(result.transcripts?.map((row) => row.status)).toEqual(["failed", "deleted", "failed", "deleted", "failed", "complete"]);
  expect(result.transcriptsNextCursor).toBe("oldest");
});

it("caps a transcript search at five pages and retains its continuation cursor", async () => {
  let pages = 0;
  const api = await Effect.runPromise(
    createChalkEffectClient({
      baseUrl: "https://api.chalk.test",
      fetch: async () => {
        pages++;
        return Response.json({ pagination: { page_size: 5, has_more: true, next_cursor: `page-${pages}` }, transcripts: [transcript(10 + pages, "deleted")] });
      },
    }),
  );
  const result = await listedRecording({ api, tenantId: Schema.decodeUnknownSync(TenantIdSchema)(id(2)), dashboardOrigin: "https://chalk.test" }, recording);
  expect(pages).toBe(5);
  expect(result.transcripts).toHaveLength(5);
  expect(result.transcriptsNextCursor).toBe("page-5");
});

it("stops at the end of a list without a completed transcript", async () => {
  let pages = 0;
  const api = await Effect.runPromise(
    createChalkEffectClient({
      baseUrl: "https://api.chalk.test",
      fetch: async () => {
        pages++;
        return Response.json({ pagination: { page_size: 5, has_more: false, next_cursor: null }, transcripts: [transcript(10, "failed")] });
      },
    }),
  );
  const result = await listedRecording({ api, tenantId: Schema.decodeUnknownSync(TenantIdSchema)(id(2)), dashboardOrigin: "https://chalk.test" }, recording);
  expect(pages).toBe(1);
  expect(result.transcripts?.map((row) => row.status)).toEqual(["failed"]);
  expect(result.transcriptsNextCursor).toBeNull();
});
