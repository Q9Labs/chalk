// @vitest-environment jsdom
import { act as reactAct, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Schema } from "effect";
import { RecordingSchema } from "@q9labsai/chalk-client/effect";
import type { ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { recordingDTO } from "../../../server/dto";
import { PastSessionPage } from "./PastSessionPage";

const router = vi.hoisted(() => ({ state: { location: { pathname: "/dashboard/call/space/session/episode" } } }));
vi.mock("@tanstack/react-router", async () => {
  const { createElement } = await import("react");
  return { Link: ({ children }: { children: ReactNode }) => createElement("a", null, children), useRouter: () => router };
});

const id = "00000000-0000-4000-8000-000000000001";
const date = "2026-10-22T10:11:26Z";
let source = "available";
let artifact = "none";
let retryable = false;
let transcriptStatus = "complete";
let metadataStatus = 200;
let transcriptHTTPStatus = 200;
let extraRecordings: ReturnType<typeof recording>[] = [];
let brokenURL: string | null = null;
let stalledTranscripts: string | null = null;
const requests: { path: string; action?: string; id?: string; recordingId?: string }[] = [];

function recording() {
  return recordingDTO(
    Schema.decodeUnknownSync(RecordingSchema)({
      id,
      tenant_id: id,
      space_id: id,
      episode_id: id,
      status: artifact === "ready" ? "completed" : "pending",
      source: { status: source },
      export: { status: artifact, retryable, failure_message: source === "failed" ? "The recording capture did not complete." : source === "expired" ? "The recording source is no longer available." : artifact === "failed" ? "The recording export could not be completed." : null },
      transcription_preparation: { status: source === "failed" ? "failed" : source === "pending" ? "pending" : "ready" },
      transcription_policy: "automatic",
      storage_provider: "r2",
      storage_key: null,
      metadata: {},
      created_at: date,
      updated_at: date,
    }),
  );
}

beforeEach(() => {
  metadataStatus = 200;
  transcriptHTTPStatus = 200;
  extraRecordings = [];
  brokenURL = null;
  stalledTranscripts = null;
  vi.useFakeTimers();
  source = "available";
  artifact = "none";
  retryable = false;
  transcriptStatus = "complete";
  requests.length = 0;
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  vi.stubGlobal("fetch", async (input: string, init?: RequestInit) => {
    const url = new URL(input, "https://chalk.test");
    const path = url.pathname;
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
    requests.push({ path, action: body?.action, id: url.searchParams.get("id") ?? undefined, recordingId: body?.recordingId });
    if (path === "/auth/session") return Response.json({ csrfToken: "fixture", profile: { name: "June", email: "june@example.test", avatarUrl: null } });
    if (path === "/dashboard-api/call") return Response.json({ call: { name: "Call" } });
    if (path === "/dashboard-api/call-metadata") return metadataStatus === 200 ? Response.json({ kind: "recording", recording: { ...recording(), id: url.searchParams.get("id") } }) : Response.json({ error: { code: "recording_not_found" } }, { status: metadataStatus });
    if (body?.action === "transcripts" && transcriptHTTPStatus !== 200) return Response.json({ error: { code: "recording_not_found" } }, { status: transcriptHTTPStatus });
    if (body?.action === "transcripts" && body.recordingId === stalledTranscripts) return new Promise<Response>(() => {});
    if (body?.action === "transcripts") return Response.json({ transcripts: transcriptStatus ? [{ id, status: transcriptStatus, languages: ["en"], createdAt: date }] : [], nextCursor: null });
    if (body?.action === "transcript-document") return Response.json({ cues: [{ startMs: 0, endMs: 1000, text: "Saved speech", speaker: null }] });
    if (body?.action === "export-recording") {
      artifact = "pending";
      return Response.json({ recording: recording() });
    }
    if (body?.action === "recording-url" && body.recordingId === brokenURL) return Response.json({ error: { code: "storage_unavailable" } }, { status: 503 });
    if (body?.action === "recording-url") return Response.json({ url: "https://storage.example.test/video.mp4" });
    if (path === "/dashboard-api/past-session") return Response.json({ episode: { id, status: "ended", startedAt: date, endedAt: date }, attendance: { kind: "available", participants: [] }, recordings: [recording(), ...extraRecordings], nextCursor: null });
    throw new Error(`Unexpected request: ${path}`);
  });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function open() {
  await reactAct(async () => {
    render(<PastSessionPage spaceId={id} episodeId={id} />);
  });
}
async function tick() {
  await reactAct(async () => {
    await vi.advanceTimersByTimeAsync(5000);
  });
}

it.each(["failed", "expired"])("shows a terminal %s source and its reason, not endless processing", async (state) => {
  source = state;
  artifact = "unavailable";
  transcriptStatus = "";
  await open();
  expect(screen.queryByText("Processing the recording")).toBeNull();
  expect(screen.getByText(state === "failed" ? "The recording capture did not complete." : "The recording source is no longer available.")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Prepare recording" })).toBeNull();
  const count = requests.length;
  await tick();
  expect(requests).toHaveLength(count);
});

it("shows canonical complete transcripts before export and prepares a playable recording on demand", async () => {
  await open();
  expect(screen.getByText("Saved speech")).toBeTruthy();
  expect(screen.queryByRole("region", { name: "Recording" })).toBeNull();
  await reactAct(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Prepare recording" }));
  });
  expect(requests.filter((request) => request.action === "export-recording")).toHaveLength(1);
  expect(screen.getByText("Preparing the recording")).toBeTruthy();
  artifact = "ready";
  await tick();
  expect(screen.getByRole("region", { name: "Recording" })).toBeTruthy();
  const count = requests.filter((request) => request.path === "/dashboard-api/call-metadata").length;
  await tick();
  expect(requests.filter((request) => request.path === "/dashboard-api/call-metadata")).toHaveLength(count);
});

it("plays a newer attempt once it is ready even after an older attempt's video failed to load", async () => {
  const older = "00000000-0000-4000-8000-000000000002";
  artifact = "pending";
  extraRecordings = [{ ...recording(), id: older, status: "completed", exportStatus: "ready" }];
  brokenURL = older;
  await open();
  expect(screen.getByText("The recording didn’t load")).toBeTruthy();
  artifact = "ready";
  await tick();
  expect(screen.queryByText("The recording didn’t load")).toBeNull();
  expect(screen.getByRole("region", { name: "Recording" })).toBeTruthy();
});

it("drops the older attempt's transcript when a newer attempt becomes the selected recording", async () => {
  const older = "00000000-0000-4000-8000-000000000002";
  artifact = "pending";
  extraRecordings = [{ ...recording(), id: older, status: "completed", exportStatus: "ready" }];
  stalledTranscripts = id;
  await open();
  expect(screen.getByText("Saved speech")).toBeTruthy();
  artifact = "ready";
  await tick();
  expect(screen.getByRole("region", { name: "Recording" })).toBeTruthy();
  expect(screen.queryByText("Saved speech")).toBeNull();
});

it("keeps a newer preparable attempt reachable while an older export plays", async () => {
  const older = "00000000-0000-4000-8000-000000000002";
  extraRecordings = [{ ...recording(), id: older, status: "completed", exportStatus: "ready" }];
  await open();
  expect(screen.getByRole("region", { name: "Recording" })).toBeTruthy();
  expect(screen.getByText("A newer recording is ready to prepare")).toBeTruthy();
  await reactAct(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Prepare recording" }));
  });
  expect(requests.filter((request) => request.action === "export-recording").map((request) => request.recordingId)).toEqual([id]);
  expect(screen.getByText("Preparing the newer recording")).toBeTruthy();
  artifact = "ready";
  await tick();
  expect(screen.queryByText("Preparing the newer recording")).toBeNull();
  expect(requests.filter((request) => request.action === "recording-url").map((request) => request.recordingId)).toEqual([older, id]);
});

it("offers an older preparable attempt when the newest attempt failed", async () => {
  const older = "00000000-0000-4000-8000-000000000002";
  extraRecordings = [{ ...recording(), id: older }];
  source = "failed";
  artifact = "unavailable";
  await open();
  expect(screen.getByText("The recording is ready to prepare")).toBeTruthy();
  await reactAct(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Prepare recording" }));
  });
  expect(requests.filter((request) => request.action === "export-recording").map((request) => request.recordingId)).toEqual([older]);
});

it("offers a transcript when the video source expired but its transcription source is ready", async () => {
  source = "expired";
  artifact = "unavailable";
  transcriptStatus = "";
  await open();
  expect(screen.getByRole("button", { name: /^Make a transcript/ })).toBeTruthy();
});

it("does not offer to create a transcript over an existing not-requested one", async () => {
  transcriptStatus = "not_requested";
  await open();
  expect(screen.getByText("There’s no transcript for this recording.")).toBeTruthy();
  expect(screen.queryByRole("button", { name: /^Make a transcript/ })).toBeNull();
});

it("replaces pending capture with its terminal reason without a reload", async () => {
  source = "pending";
  artifact = "unavailable";
  transcriptStatus = "";
  await open();
  expect(screen.getByText("Processing the recording")).toBeTruthy();
  source = "failed";
  await tick();
  expect(screen.getByText("The recording capture did not complete.")).toBeTruthy();
  expect(screen.queryByText("Processing the recording")).toBeNull();
});

it.each([404, 410])("keeps the session and another recording when one pending recording disappears: %s", async (status) => {
  source = "pending";
  artifact = "unavailable";
  extraRecordings = [{ ...recording(), id: "00000000-0000-4000-8000-000000000002", status: "completed", sourceStatus: "available", exportStatus: "ready", transcriptionStatus: "ready" }];
  await open();
  expect(screen.getByRole("region", { name: "Recording" })).toBeTruthy();
  metadataStatus = status;
  await tick();
  expect(screen.queryByText("Couldn’t load this session")).toBeNull();
  expect(screen.getByRole("region", { name: "Recording" })).toBeTruthy();
  expect(screen.getByText("Who came")).toBeTruthy();
  const count = requests.length;
  await tick();
  expect(requests).toHaveLength(count);
});

it.each([403, 503])("preserves page-level authorization and transient-error handling: %s", async (status) => {
  source = "pending";
  artifact = "unavailable";
  transcriptStatus = "";
  await open();
  metadataStatus = status;
  await tick();
  expect(Boolean(screen.queryByText("Couldn’t load this session"))).toBe(status === 403);
  expect(Boolean(screen.queryByText("Processing the recording"))).toBe(status === 503);
});

it.each([true, false])("offers export retry only when the server permits it: %s", async (allowed) => {
  artifact = "failed";
  retryable = allowed;
  await open();
  expect(screen.getByText("The recording export could not be completed.")).toBeTruthy();
  expect(Boolean(screen.queryByRole("button", { name: "Try again" }))).toBe(allowed);
});

it("shows a terminal transcript failure rather than polling it forever", async () => {
  transcriptStatus = "terminal_failure";
  await open();
  expect(screen.getByText("The transcript couldn’t be made")).toBeTruthy();
  const count = requests.length;
  await tick();
  expect(requests).toHaveLength(count);
});

it.each([404, 410])("shows an unavailable transcript when the selected recording disappears: %s", async (status) => {
  source = "pending";
  artifact = "unavailable";
  transcriptStatus = "";
  await open();
  metadataStatus = status;
  transcriptHTTPStatus = status;
  await tick();
  expect(screen.getByText("The recording source is no longer available.")).toBeTruthy();
  expect(screen.getByText("No transcript is available because the recording source could not be kept.")).toBeTruthy();
  expect(screen.queryByText("The transcript couldn’t be made")).toBeNull();
});

it("shares metadata polling across pending attempts with one request per tick", async () => {
  source = "pending";
  artifact = "unavailable";
  transcriptStatus = "";
  const second = "00000000-0000-4000-8000-000000000002";
  const third = "00000000-0000-4000-8000-000000000003";
  extraRecordings = [second, third].map((id) => ({ ...recording(), id }));
  await open();
  await tick();
  expect(requests.filter((request) => request.path === "/dashboard-api/call-metadata").map((request) => request.id)).toEqual([id]);
  await tick();
  await tick();
  expect(requests.filter((request) => request.path === "/dashboard-api/call-metadata").map((request) => request.id)).toEqual([id, second, third]);
});
