import { Effect, Schema } from "effect";
import { createChalkEffectClient, RecordingSchema, TenantIdSchema } from "@q9labsai/chalk-client/effect";
import { expect, it } from "vitest";
import { listedRecording } from "./engine";
import { recordingDTO } from "./dto";
import { callMetadata } from "./call";
import { pastMutation } from "./past-session";

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

it.each(["call", "past-session"] as const)("reads exactly one %s transcript page and discards its continuation", async (view) => {
  const requests: URL[] = [];
  const pageSize = view === "call" ? 5 : 100;
  const api = await Effect.runPromise(
    createChalkEffectClient({
      baseUrl: "https://api.chalk.test",
      fetch: async (input) => {
        const url = new URL(String(input));
        requests.push(url);
        const rows = Array.from({ length: pageSize }, (_, index) => transcript(index + 10, index === 99 ? "complete" : index % 2 ? "deleted" : "failed"));
        return Response.json({ pagination: { page_size: pageSize, has_more: true, next_cursor: "more" }, transcripts: rows });
      },
    }),
  );
  const result = await listedRecording({ api, tenantId: Schema.decodeUnknownSync(TenantIdSchema)(id(2)), dashboardOrigin: "https://chalk.test" }, recording, view);
  expect(requests).toHaveLength(1);
  expect(requests[0]?.searchParams.get("page_size")).toBe(String(pageSize));
  expect(requests[0]?.searchParams.has("cursor")).toBe(false);
  expect(result.transcripts).toHaveLength(pageSize);
  expect(result.transcripts?.some((row) => row.status === "complete")).toBe(view === "past-session");
  expect(Object.keys(result)).toEqual([...Object.keys(recordingDTO(recording)), "transcripts"]);
});

it.each(["call", "past-session"] as const)("keeps %s metadata and list retries at the same single-page size", async (view) => {
  const requests: URL[] = [];
  const api = await Effect.runPromise(
    createChalkEffectClient({
      baseUrl: "https://api.chalk.test",
      fetch: async (input) => {
        const url = new URL(String(input));
        requests.push(url);
        return url.pathname.endsWith(`/recordings/${recording.id}`) ? Response.json(recording) : Response.json({ pagination: { page_size: view === "call" ? 5 : 100, has_more: true, next_cursor: "more" }, transcripts: [] });
      },
    }),
  );
  const engine = { api, tenantId: Schema.decodeUnknownSync(TenantIdSchema)(id(2)), dashboardOrigin: "https://chalk.test" };
  await callMetadata(engine, { kind: "recording", spaceId: recording.space_id, id: recording.id, view });
  const result = await pastMutation(engine, { action: "transcripts", spaceId: recording.space_id, episodeId: recording.episode_id, recordingId: recording.id, view });
  const lists = requests.filter((url) => url.pathname.endsWith("/transcripts"));
  expect(lists.map((url) => url.searchParams.get("page_size"))).toEqual([String(view === "call" ? 5 : 100), String(view === "call" ? 5 : 100)]);
  expect(lists.every((url) => !url.searchParams.has("cursor"))).toBe(true);
  expect(result).toEqual({ transcripts: [] });
});
