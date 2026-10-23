// @vitest-environment jsdom
import { act as reactAct, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Schema } from "effect";
import { RecordingSchema } from "@q9labsai/chalk-client/effect";
import type { ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { recordingDTO } from "../../../server/dto";
import { clock } from "../../lib/dashboard/format";
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
let recordingState: string | null = null;
let transcriptionSource: string | null = null;
let expiresAt: string | null = null;
let transcriptionExpiresAt: string | null = null;
let exportHTTPStatus = 202;
let createHTTPStatus = 200;
let serverLagMs = 0;
let legacyExport = false;
let metadataDelayMs = 0;
let visibility: DocumentVisibilityState = "visible";
const inFlight = new Map<string, number>();
let maxInFlight = 0;
let listedTranscripts: { id: string; status: string; languages: string[]; createdAt: string }[] | undefined;
const requests: { path: string; action?: string; id?: string; recordingId?: string }[] = [];

// The API derives these states at read time by its own clock (recording_pipeline.sql:663-699), so the mock server does too.
function served() {
  const at = Date.now() - serverLagMs;
  const closed = (deadline: string | null) => deadline !== null && Date.parse(deadline) <= at;
  const sourceClosed = source === "available" && closed(expiresAt);
  const preparation = transcriptionSource ?? (source === "failed" ? "failed" : source === "pending" ? "pending" : "ready");
  return {
    source: sourceClosed ? "expired" : source,
    // A rendered artifact expires with its source; a legacy one has no expiry and stays ready.
    export: sourceClosed && !(artifact === "ready" && legacyExport) ? "unavailable" : artifact,
    retryable: retryable && !sourceClosed,
    // A closed source window expires every preparation state except one with no source and no job (recording_pipeline.sql:673-684).
    transcription: (preparation !== "none" && sourceClosed) || (preparation === "ready" && closed(transcriptionExpiresAt)) ? "expired" : preparation,
  };
}

function transcriptsOf(recordingId: string) {
  const extra = extraRecordings.find((item) => item.id === recordingId);
  if (extra) return extra.transcripts ?? [];
  return listedTranscripts ?? (transcriptStatus ? [{ id, status: transcriptStatus, languages: ["en"], createdAt: date }] : []);
}

function recording() {
  const state = served();
  return recordingDTO(
    Schema.decodeUnknownSync(RecordingSchema)({
      id,
      tenant_id: id,
      space_id: id,
      episode_id: id,
      status: recordingState ?? (artifact === "ready" ? "completed" : "pending"),
      source: { status: state.source, ...(expiresAt ? { expires_at: expiresAt } : {}) },
      export: {
        status: state.export,
        retryable: state.retryable,
        failure_message: state.source === "failed" ? "The recording capture did not complete." : state.source === "expired" ? "The recording source is no longer available." : state.export === "failed" ? "The recording export could not be completed." : null,
      },
      transcription_preparation: { status: state.transcription, ...(transcriptionExpiresAt ? { expires_at: transcriptionExpiresAt } : {}) },
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
  listedTranscripts = undefined;
  visibility = "visible";
  inFlight.clear();
  maxInFlight = 0;
  brokenURL = null;
  recordingState = null;
  transcriptionSource = null;
  expiresAt = null;
  transcriptionExpiresAt = null;
  exportHTTPStatus = 202;
  createHTTPStatus = 200;
  serverLagMs = 0;
  legacyExport = false;
  metadataDelayMs = 0;
  vi.useFakeTimers();
  source = "available";
  artifact = "none";
  retryable = false;
  transcriptStatus = "complete";
  requests.length = 0;
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
  vi.stubGlobal("fetch", async (input: string, init?: RequestInit) => {
    const response = await route(input, init);
    // The page places the server's deadlines on its own clock with this header.
    response.headers.set("Date", new Date(Date.now() - serverLagMs).toUTCString());
    return response;
  });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function route(input: string, init?: RequestInit): Promise<Response> {
  const url = new URL(input, "https://chalk.test");
  const path = url.pathname;
  const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
  requests.push({ path, action: body?.action, id: url.searchParams.get("id") ?? undefined, recordingId: body?.recordingId });
  if (path === "/auth/session") return Response.json({ csrfToken: "fixture", profile: { name: "June", email: "june@example.test", avatarUrl: null } });
  if (path === "/dashboard-api/call") return Response.json({ call: { name: "Call" } });
  if (path === "/dashboard-api/call-metadata") {
    const key = url.searchParams.get("id") ?? "";
    inFlight.set(key, (inFlight.get(key) ?? 0) + 1);
    maxInFlight = Math.max(maxInFlight, inFlight.get(key) ?? 0);
    if (metadataDelayMs) await new Promise((resolve) => setTimeout(resolve, metadataDelayMs));
    inFlight.set(key, (inFlight.get(key) ?? 1) - 1);
  }
  if (path === "/dashboard-api/call-metadata") {
    const key = url.searchParams.get("id") ?? "";
    if (metadataStatus !== 200) return Response.json({ error: { code: "recording_not_found" } }, { status: metadataStatus });
    // The server lists the recording's transcripts in the same read when it can, and leaves them out when it can't (engine.ts).
    return Response.json({ kind: "recording", recording: { ...recording(), id: key, ...(transcriptHTTPStatus === 200 ? { transcripts: transcriptsOf(key), transcriptsNextCursor: null } : {}) } });
  }
  if (body?.action === "transcripts" && transcriptHTTPStatus !== 200) return Response.json({ error: { code: "recording_not_found" } }, { status: transcriptHTTPStatus });
  if (body?.action === "transcripts") return Response.json({ transcripts: transcriptsOf(body.recordingId), nextCursor: null });
  if (body?.action === "transcript-document") return Response.json({ cues: [{ startMs: 0, endMs: 1000, text: "Saved speech", speaker: null }] });
  if (body?.action === "export-recording" && exportHTTPStatus !== 202) return Response.json({ error: { code: "recording.not_ready" } }, { status: exportHTTPStatus });
  // transcripts.go:218-231 refuses a source that isn't ready by the server's clock.
  if (body?.action === "create-transcript" && served().transcription !== "ready" && transcriptStatus === "") return Response.json({ error: { code: "transcript.source_expired" } }, { status: 409 });
  if (body?.action === "create-transcript" && createHTTPStatus !== 200) return Response.json({ error: { code: "transcript.source_expired" } }, { status: createHTTPStatus });
  if (body?.action === "create-transcript") {
    transcriptStatus = "preparing";
    return Response.json({ transcript: { id, status: "preparing", languages: ["en"], createdAt: date } });
  }
  if (body?.action === "export-recording" && (served().source === "expired" || served().export === "unavailable")) return Response.json({ recording: recording() });
  if (body?.action === "export-recording") {
    artifact = "pending";
    return Response.json({ recording: recording() });
  }
  if (body?.action === "recording-url" && body.recordingId === brokenURL) return Response.json({ error: { code: "storage_unavailable" } }, { status: 503 });
  if (body?.action === "recording-url") return Response.json({ url: "https://storage.example.test/video.mp4" });
  if (path === "/dashboard-api/past-session")
    return Response.json({
      episode: { id, status: "ended", startedAt: date, endedAt: date },
      attendance: { kind: "available", participants: [] },
      // The server leaves an attempt unlisted when its transcript list fails, rather than failing the session (engine.ts).
      recordings: [recording(), ...extraRecordings].map((item) => (transcriptHTTPStatus === 200 ? { ...item, transcripts: transcriptsOf(item.id), transcriptsNextCursor: null } : item)),
      nextCursor: null,
    });
  throw new Error(`Unexpected request: ${path}`);
}

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

it("keeps the older attempt's transcript, named by its time, when a newer attempt's video becomes the one shown", async () => {
  const older = "00000000-0000-4000-8000-000000000002";
  artifact = "pending";
  transcriptStatus = "";
  extraRecordings = [{ ...recording(), id: older, status: "completed", exportStatus: "ready", createdAt: "2026-10-22T09:00:00Z", transcripts: [{ id: older, status: "complete", languages: ["en"], createdAt: date }] }];
  await open();
  expect(screen.getByText("Saved speech")).toBeTruthy();
  expect(screen.getByRole("button", { name: /^Play from/ })).toBeTruthy();
  artifact = "ready";
  await tick();
  expect(requests.filter((request) => request.action === "recording-url").map((request) => request.recordingId)).toEqual([older, id]);
  expect(screen.getByText("Saved speech")).toBeTruthy();
  expect(screen.getByText(`From the ${clock("2026-10-22T09:00:00Z")} recording`)).toBeTruthy();
  expect(screen.queryByRole("button", { name: /^Play from/ })).toBeNull();
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

it("plays an older attempt's video and shows a newer attempt's completed transcript, named by its time", async () => {
  const older = "00000000-0000-4000-8000-000000000002";
  // The newest attempt's video expired, but it finished a transcript; the older attempt still has a playable export.
  source = "expired";
  artifact = "unavailable";
  listedTranscripts = [{ id, status: "complete", languages: ["en"], createdAt: date }];
  extraRecordings = [{ ...recording(), id: older, status: "completed", sourceStatus: "available", exportStatus: "ready", createdAt: "2026-10-22T09:00:00Z", transcripts: [] }];
  await open();
  expect(screen.getByRole("region", { name: "Recording" })).toBeTruthy();
  expect(requests.filter((request) => request.action === "recording-url").map((request) => request.recordingId)).toEqual([older]);
  expect(requests.filter((request) => request.action === "transcript-document")).toHaveLength(1);
  expect(screen.getByText("Saved speech")).toBeTruthy();
  expect(screen.getByText(`From the ${clock(date)} recording`)).toBeTruthy();
  // Its lines belong to another attempt's timeline, so they don't seek this video.
  expect(screen.queryByRole("button", { name: /^Play from/ })).toBeNull();
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

it.each([202, 400, 409])("removes the prepare action when an export is refused because the source expired meanwhile: %s", async (status) => {
  exportHTTPStatus = status;
  await open();
  expect(screen.getByRole("button", { name: "Prepare recording" })).toBeTruthy();
  source = "expired";
  artifact = "unavailable";
  await reactAct(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Prepare recording" }));
  });
  // An accepted request answers with the closed source; a refusal is read again at the next tick.
  await tick();
  expect(metadataReads()).toBe(status === 202 ? 0 : 1);
  expect(screen.getByText("The recording is no longer available")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Prepare recording" })).toBeNull();
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

it.each([403, 503])("keeps the session when one recording's read is refused or fails: %s", async (status) => {
  source = "pending";
  artifact = "unavailable";
  transcriptStatus = "";
  await open();
  metadataStatus = status;
  await tick();
  expect(screen.queryByText("Couldn’t load this session")).toBeNull();
  expect(screen.getByText("Who came")).toBeTruthy();
  // A refusal is final for that recording and shows its error; a server failure keeps the last answer and is retried.
  expect(Boolean(screen.queryByText("Couldn’t load this recording"))).toBe(status === 403);
  expect(Boolean(screen.queryByText("Processing the recording"))).toBe(status === 503);
  const reads = metadataReads();
  await tick();
  await tick();
  expect(metadataReads() > reads).toBe(status === 503);
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

it.each([404, 410])("shows the server's error on the video and the transcript when the selected recording disappears: %s", async (status) => {
  source = "pending";
  artifact = "unavailable";
  transcriptStatus = "";
  await open();
  metadataStatus = status;
  await tick();
  expect(screen.getByText("Couldn’t load this recording")).toBeTruthy();
  expect(screen.getByText("Couldn’t load the transcript")).toBeTruthy();
  expect(screen.queryByText("Processing the recording")).toBeNull();
  expect(screen.queryByText("The transcript couldn’t be made")).toBeNull();
  const reads = metadataReads();
  await advance(60_000);
  expect(metadataReads()).toBe(reads);
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

const TRANSCRIPT_ROWS = ["", "pending", "processing", "completed", "failed", "not_requested", "preparing", "transcribing", "verifying", "complete", "retryable_failure", "terminal_failure", "deleted"];

// What the API allows, written from the API rather than from the page: transcripts.go:206 refuses a request over any
// existing row, and :211-231 needs a transcription source that is ready and unexpired (preparation "ready").
function transcriptExpectation(row: string, preparation: string): { readonly text: string; readonly create: boolean } {
  if (row === "complete" || row === "completed") return { text: "Saved speech", create: false };
  if (["pending", "processing", "preparing", "transcribing", "verifying", "retryable_failure"].includes(row)) return { text: "The transcript is being prepared.", create: false };
  if (row === "failed" || row === "terminal_failure") return { text: "The transcript couldn’t be made", create: false };
  if (row === "deleted") return { text: "This transcript was deleted.", create: false };
  if (row === "not_requested") return { text: "There’s no transcript for this recording.", create: false };
  if (preparation === "ready") return { text: "There’s no transcript for this recording.", create: true };
  if (preparation === "pending") return { text: "The transcript is being prepared.", create: false };
  if (preparation === "failed") return { text: "The transcript couldn’t be made", create: false };
  if (preparation === "expired") return { text: "A transcript can no longer be made for this recording.", create: false };
  return { text: "There’s no transcript for this recording.", create: false };
}

it("offers a transcript in exactly the 1,040 state combinations the API accepts, with the matching copy", async () => {
  const mismatches = [];
  let count = 0;
  for (const recordingStatus of ["pending", "processing", "completed", "failed"]) {
    for (const videoSource of ["pending", "available", "failed", "expired"]) {
      for (const preparation of ["none", "pending", "ready", "failed", "expired"]) {
        for (const row of TRANSCRIPT_ROWS) {
          recordingState = recordingStatus;
          source = videoSource;
          transcriptionSource = preparation;
          transcriptStatus = row;
          artifact = "none";
          await open();
          const expected = transcriptExpectation(row, preparation);
          const create = screen.queryByRole("button", { name: /^Make a transcript/ }) !== null;
          const shown = screen.queryAllByText(expected.text).length > 0;
          if (create !== expected.create || !shown) mismatches.push({ recordingStatus, videoSource, preparation, row: row || "absent", create, shown });
          count += 1;
          cleanup();
        }
      }
    }
  }
  expect(count).toBe(1040);
  expect(mismatches).toEqual([]);
}, 120_000);

it("shows the one video action the API accepts in every recording, source and export state, and polls exactly while it shows a wait", async () => {
  const mismatches = [];
  transcriptStatus = "complete";
  // Transcription preparation polls on its own, so it is held still here to judge the video's waits alone.
  transcriptionSource = "none";
  for (const recordingStatus of ["pending", "processing", "completed", "failed"]) {
    for (const videoSource of ["pending", "available", "failed", "expired"]) {
      for (const exportStatus of ["none", "pending", "ready", "failed", "unavailable"]) {
        for (const exportRetryable of [false, true]) {
          recordingState = recordingStatus;
          source = videoSource;
          artifact = exportStatus;
          retryable = exportRetryable;
          requests.length = 0;
          await open();
          // recordings.go:254-263 signs a video URL only for a completed recording with a ready export.
          const play = exportStatus === "ready" && recordingStatus === "completed";
          // E15-E17: an export request changes anything only for an open source with no export, or a retryable failed one.
          const prepare = videoSource === "available" && exportStatus === "none";
          const retry = videoSource === "available" && exportStatus === "failed" && exportRetryable;
          const shown = {
            play: screen.queryByRole("region", { name: "Recording" }) !== null,
            prepare: screen.queryByRole("button", { name: "Prepare recording" }) !== null,
            retry: screen.queryByRole("button", { name: "Try again" }) !== null,
          };
          const waiting = document.querySelector(".pnote .spin") !== null;
          const before = requests.filter((request) => request.path === "/dashboard-api/call-metadata").length;
          await tick();
          const polled = requests.filter((request) => request.path === "/dashboard-api/call-metadata").length > before;
          if (shown.play !== play || shown.prepare !== prepare || shown.retry !== retry || waiting !== polled) mismatches.push({ recordingStatus, videoSource, exportStatus, exportRetryable, ...shown, waiting, polled });
          cleanup();
        }
      }
    }
  }
  expect(mismatches).toEqual([]);
}, 120_000);

it("rereads the recording after a refused transcript request so a dead action disappears", async () => {
  transcriptStatus = "";
  await open();
  transcriptionSource = "expired";
  createHTTPStatus = 409;
  await reactAct(async () => {
    fireEvent.click(screen.getByRole("button", { name: /^Make a transcript/ }));
  });
  // The refusal is read again at the next tick, and only that answer removes the action.
  expect(metadataReads()).toBe(0);
  expect(screen.getByRole("button", { name: /^Make a transcript/ })).toBeTruthy();
  await tick();
  expect(metadataReads()).toBe(1);
  expect(screen.queryByRole("button", { name: /^Make a transcript/ })).toBeNull();
  expect(screen.getByText("A transcript can no longer be made for this recording.")).toBeTruthy();
});

it("shows the new transcript as being prepared once its request is accepted", async () => {
  transcriptStatus = "";
  await open();
  await reactAct(async () => {
    fireEvent.click(screen.getByRole("button", { name: /^Make a transcript/ }));
  });
  expect(requests.filter((request) => request.action === "create-transcript")).toHaveLength(1);
  expect(screen.getByText("The transcript is being prepared.")).toBeTruthy();
  expect(screen.queryByRole("button", { name: /^Make a transcript/ })).toBeNull();
});

it("shows a transcript another request created when this page's request is refused", async () => {
  transcriptStatus = "";
  await open();
  transcriptStatus = "complete";
  createHTTPStatus = 409;
  await reactAct(async () => {
    fireEvent.click(screen.getByRole("button", { name: /^Make a transcript/ }));
  });
  // One tick reads the recording's transcripts, the next reads the finished one's lines.
  await tick();
  await tick();
  expect(screen.getByText("Saved speech")).toBeTruthy();
  expect(screen.queryByRole("button", { name: /^Make a transcript/ })).toBeNull();
});

it("reads the transcripts again when the recording's transcription preparation changes", async () => {
  source = "pending";
  artifact = "unavailable";
  transcriptStatus = "";
  await open();
  expect(screen.getByText("The transcript is being prepared.")).toBeTruthy();
  source = "available";
  artifact = "none";
  transcriptStatus = "complete";
  await tick();
  await tick();
  expect(screen.getByText("Saved speech")).toBeTruthy();
});

it("retries a transcript list that failed to load instead of calling the transcript failed", async () => {
  transcriptHTTPStatus = 503;
  await open();
  transcriptHTTPStatus = 200;
  await reactAct(async () => {
    await vi.advanceTimersByTimeAsync(15_000);
  });
  expect(screen.getByText("Saved speech")).toBeTruthy();
  expect(screen.queryByText("The transcript couldn’t be made")).toBeNull();
});

it("says a newer attempt failed when it can only be retried", async () => {
  const older = "00000000-0000-4000-8000-000000000002";
  artifact = "failed";
  retryable = true;
  extraRecordings = [{ ...recording(), id: older, status: "completed", exportStatus: "ready", exportRetryable: false, failureMessage: null }];
  await open();
  expect(screen.getByRole("region", { name: "Recording" })).toBeTruthy();
  expect(screen.getByText("A newer recording couldn’t be prepared")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
  expect(screen.queryByText("A newer recording is ready to prepare")).toBeNull();
});

const metadataReads = () => requests.filter((request) => request.path === "/dashboard-api/call-metadata").length;
async function advance(ms: number) {
  await reactAct(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

it("marks the recording due when its source window ends and closes the actions only on the server's answer", async () => {
  vi.setSystemTime(new Date("2026-10-22T12:00:00Z"));
  expiresAt = "2026-10-22T12:01:00Z";
  transcriptStatus = "";
  await open();
  expect(screen.getByRole("button", { name: "Prepare recording" })).toBeTruthy();
  expect(screen.getByRole("button", { name: /^Make a transcript/ })).toBeTruthy();
  await advance(60_000);
  // The deadline schedules a read in the polling rotation; until the server answers, the action stays.
  expect(metadataReads()).toBe(0);
  expect(screen.getByRole("button", { name: "Prepare recording" })).toBeTruthy();
  await advance(5_000);
  expect(metadataReads()).toBe(1);
  expect(screen.queryByRole("button", { name: "Prepare recording" })).toBeNull();
  expect(screen.getByText("The recording is no longer available")).toBeTruthy();
  expect(screen.queryByRole("button", { name: /^Make a transcript/ })).toBeNull();
  expect(screen.getByText("A transcript can no longer be made for this recording.")).toBeTruthy();
  await tick();
  expect(metadataReads()).toBe(1);
});

it.each([
  ["stops playing a rendered export", false],
  ["keeps playing a legacy export the server still serves", true],
])("%s when its source window ends", async (_name, legacy) => {
  vi.setSystemTime(new Date("2026-10-22T12:00:00Z"));
  expiresAt = "2026-10-22T12:01:00Z";
  artifact = "ready";
  legacyExport = legacy;
  await open();
  expect(screen.getByRole("region", { name: "Recording" })).toBeTruthy();
  await advance(60_000);
  await advance(5_000);
  expect(metadataReads()).toBe(1);
  expect(screen.queryByRole("region", { name: "Recording" }) !== null).toBe(legacy);
  if (!legacy) expect(screen.getByText("The recording is no longer available")).toBeTruthy();
  await tick();
  expect(metadataReads()).toBe(1);
});

it("closes the prepare action at a source deadline beyond the longest browser timer", async () => {
  vi.setSystemTime(new Date("2026-10-22T12:00:00Z"));
  // The default retention is 30 days, past setTimeout's 24.8-day limit.
  expiresAt = "2026-11-21T12:00:00Z";
  transcriptStatus = "";
  await open();
  // An idle open window is read again every five minutes, which also keeps every timer short.
  await advance(5 * 60_000);
  await tick();
  expect(metadataReads()).toBe(1);
  expect(screen.getByRole("button", { name: "Prepare recording" })).toBeTruthy();
  // The machine sleeps past the deadline; the next timer to fire finds it due.
  vi.setSystemTime(new Date("2026-11-21T12:00:01Z"));
  await advance(5 * 60_000);
  await tick();
  expect(screen.queryByRole("button", { name: "Prepare recording" })).toBeNull();
  expect(screen.getByText("The recording is no longer available")).toBeTruthy();
});

it("offers a transcript from a ready source only while both its own deadline and the video's are ahead", async () => {
  vi.setSystemTime(new Date("2026-10-22T12:00:00Z"));
  const deadlines = { none: null, past: "2026-10-22T11:59:00Z", ahead: "2026-10-22T13:00:00Z" } as const;
  const mismatches = [];
  for (const transcription of ["none", "past", "ahead"] as const) {
    for (const video of ["none", "past", "ahead"] as const) {
      transcriptStatus = "";
      transcriptionSource = "ready";
      transcriptionExpiresAt = deadlines[transcription];
      expiresAt = deadlines[video];
      requests.length = 0;
      await open();
      // transcripts.go:218-231 refuses a source whose expires_at has passed, and it never outlives the video source (schema.sql:402-414).
      const allowed = transcription !== "past" && video !== "past";
      const create = screen.queryByRole("button", { name: /^Make a transcript/ }) !== null;
      const copy = screen.queryAllByText(allowed ? "There’s no transcript for this recording." : "A transcript can no longer be made for this recording.").length > 0;
      // The server already reports these windows closed, so nothing is left to ask it.
      if (create !== allowed || !copy || metadataReads() !== 0) mismatches.push({ transcription, video, create, copy, reads: metadataReads() });
      cleanup();
    }
  }
  expect(mismatches).toEqual([]);
});

it.each([
  ["before the video", "2026-10-22T12:00:30Z", 30_000],
  ["together with the video", "2026-10-22T12:01:00Z", 60_000],
])("closes the transcript action at its own deadline when it expires %s", async (_name, transcriptionDeadline, at) => {
  vi.setSystemTime(new Date("2026-10-22T12:00:00Z"));
  expiresAt = "2026-10-22T12:01:00Z";
  transcriptionExpiresAt = transcriptionDeadline;
  transcriptStatus = "";
  await open();
  expect(screen.getByRole("button", { name: /^Make a transcript/ })).toBeTruthy();
  await advance(at - 1_000);
  expect(screen.getByRole("button", { name: /^Make a transcript/ })).toBeTruthy();
  expect(metadataReads()).toBe(0);
  await advance(1_000);
  expect(screen.getByRole("button", { name: /^Make a transcript/ })).toBeTruthy();
  await advance(5_000);
  expect(metadataReads()).toBe(1);
  expect(screen.queryByRole("button", { name: /^Make a transcript/ })).toBeNull();
  expect(screen.getByText("A transcript can no longer be made for this recording.")).toBeTruthy();
  // The video keeps its own, later deadline.
  expect(screen.queryByRole("button", { name: "Prepare recording" }) !== null).toBe(at < 60_000);
  if (at < 60_000) await advance(55_000 - at);
  await advance(5_000);
  expect(screen.queryByRole("button", { name: "Prepare recording" })).toBeNull();
});

it("keeps the actions the server still accepts when this page's clock runs ahead, until the server agrees", async () => {
  vi.setSystemTime(new Date("2026-10-22T12:00:00Z"));
  // The server's clock is 30 seconds behind the page's.
  serverLagMs = 30_000;
  expiresAt = "2026-10-22T12:01:00Z";
  transcriptStatus = "";
  await open();
  // The deadline falls due by the server's clock, 30 seconds after the page's own.
  await advance(90_000);
  expect(metadataReads()).toBe(0);
  expect(screen.getByRole("button", { name: "Prepare recording" })).toBeTruthy();
  expect(screen.getByRole("button", { name: /^Make a transcript/ })).toBeTruthy();
  await advance(5_000);
  expect(metadataReads()).toBe(1);
  expect(screen.queryByRole("button", { name: "Prepare recording" })).toBeNull();
  expect(screen.queryByRole("button", { name: /^Make a transcript/ })).toBeNull();
  const reads = metadataReads();
  await tick();
  expect(metadataReads()).toBe(reads);
});

it("keeps asking about a lapsed export when the server's first answer fails", async () => {
  vi.setSystemTime(new Date("2026-10-22T12:00:00Z"));
  expiresAt = "2026-10-22T12:01:00Z";
  artifact = "ready";
  await open();
  metadataStatus = 503;
  await advance(60_000);
  await advance(5_000);
  expect(metadataReads()).toBe(1);
  expect(screen.getByRole("region", { name: "Recording" })).toBeTruthy();
  metadataStatus = 200;
  await tick();
  await tick();
  expect(screen.queryByRole("region", { name: "Recording" })).toBeNull();
  expect(screen.getByText("The recording is no longer available")).toBeTruthy();
});

it("retries a transcript refresh that fails after an earlier read succeeded", async () => {
  transcriptStatus = "";
  await open();
  expect(screen.getByRole("button", { name: /^Make a transcript/ })).toBeTruthy();
  // Another client made the transcript, so this page's request is refused, and the reread that follows fails once.
  transcriptStatus = "complete";
  createHTTPStatus = 409;
  transcriptHTTPStatus = 503;
  await reactAct(async () => {
    fireEvent.click(screen.getByRole("button", { name: /^Make a transcript/ }));
  });
  transcriptHTTPStatus = 200;
  await advance(15_000);
  expect(screen.getByText("Saved speech")).toBeTruthy();
  expect(screen.queryByRole("button", { name: /^Make a transcript/ })).toBeNull();
});

it("closes the prepare action on the server's answer when this page's clock runs behind", async () => {
  vi.setSystemTime(new Date("2026-10-22T12:00:00Z"));
  // The server's clock is 30 seconds ahead of the page's.
  serverLagMs = -30_000;
  expiresAt = "2026-10-22T12:01:00Z";
  transcriptStatus = "";
  await open();
  // The server closes the window early, before any deadline the page knows about, so it keeps the action until told.
  await advance(20_000);
  source = "expired";
  artifact = "unavailable";
  expect(screen.getByRole("button", { name: "Prepare recording" })).toBeTruthy();
  // recordings.go:161-175 answers a closed source with 202 and its unavailable state, which the page shows at once.
  await reactAct(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Prepare recording" }));
  });
  expect(screen.queryByRole("button", { name: "Prepare recording" })).toBeNull();
  expect(screen.getByText("The recording is no longer available")).toBeTruthy();
});

it("asks the server at its own deadline when this page's clock runs behind and nothing was clicked", async () => {
  vi.setSystemTime(new Date("2026-10-22T12:00:00Z"));
  serverLagMs = -30_000;
  expiresAt = "2026-10-22T12:01:00Z";
  transcriptStatus = "";
  await open();
  // The server's clock reaches the deadline when the page's shows 12:00:30.
  await advance(30_000);
  expect(metadataReads()).toBe(0);
  expect(screen.getByRole("button", { name: "Prepare recording" })).toBeTruthy();
  await advance(5_000);
  expect(metadataReads()).toBe(1);
  expect(screen.queryByRole("button", { name: "Prepare recording" })).toBeNull();
  expect(screen.queryByRole("button", { name: /^Make a transcript/ })).toBeNull();
});

it("closes the transcript action on the server's refusal when this page's clock runs behind", async () => {
  vi.setSystemTime(new Date("2026-10-22T12:00:00Z"));
  serverLagMs = -30_000;
  expiresAt = "2026-10-22T12:01:00Z";
  transcriptStatus = "";
  await open();
  // The server closes the transcription window early, before any deadline the page knows about.
  await advance(20_000);
  transcriptionSource = "expired";
  await reactAct(async () => {
    fireEvent.click(screen.getByRole("button", { name: /^Make a transcript/ }));
  });
  expect(requests.filter((request) => request.action === "create-transcript")).toHaveLength(1);
  await tick();
  expect(screen.queryByRole("button", { name: /^Make a transcript/ })).toBeNull();
  expect(screen.getByText("A transcript can no longer be made for this recording.")).toBeTruthy();
  expect(screen.queryByText("The transcript is being prepared.")).toBeNull();
});

it("moves a transcript still being prepared to closed when the server closes the source window", async () => {
  vi.setSystemTime(new Date("2026-10-22T12:00:00Z"));
  expiresAt = "2026-10-22T12:01:00Z";
  transcriptionSource = "pending";
  transcriptStatus = "";
  await open();
  expect(screen.getByText("The transcript is being prepared.")).toBeTruthy();
  await advance(65_000);
  expect(screen.getByText("A transcript can no longer be made for this recording.")).toBeTruthy();
  const reads = metadataReads();
  await tick();
  expect(metadataReads()).toBe(reads);
});

it("reads at most one recording per tick when 30 deadlines pass at once", async () => {
  vi.setSystemTime(new Date("2026-10-22T12:00:00Z"));
  expiresAt = "2026-10-22T12:01:00Z";
  transcriptStatus = "";
  // The past-session endpoint returns up to 30 attempts.
  extraRecordings = Array.from({ length: 29 }, (_, index) => ({ ...recording(), id: `00000000-0000-4000-8000-${String(index + 2).padStart(12, "0")}` }));
  await open();
  // Count from the tick before the deadline, so a burst of reads at the deadline lands inside a counted tick.
  await advance(55_000);
  const perTick = [];
  for (let step = 0; step < 33; step += 1) {
    const before = metadataReads();
    await tick();
    perTick.push(metadataReads() - before);
  }
  expect(Math.max(...perTick)).toBeLessThanOrEqual(1);
  expect(metadataReads()).toBe(30);
  expect(screen.queryByRole("button", { name: "Prepare recording" })).toBeNull();
  expect(screen.getByText("The recording is no longer available")).toBeTruthy();
});

it("keeps resumed tabs to one paced recording read at a time and applies every answer", async () => {
  vi.setSystemTime(new Date("2026-10-22T12:00:00Z"));
  expiresAt = "2026-10-22T12:01:00Z";
  transcriptStatus = "";
  extraRecordings = Array.from({ length: 29 }, (_, index) => ({ ...recording(), id: `00000000-0000-4000-8000-${String(index + 2).padStart(12, "0")}` }));
  // Each read stays in flight for most of a tick, so a resume could overlap or cut one off.
  metadataDelayMs = 4_000;
  await open();
  async function resume() {
    for (const next of ["hidden", "visible"] as const) {
      visibility = next;
      await reactAct(async () => {
        document.dispatchEvent(new Event("visibilitychange"));
      });
    }
  }
  await advance(60_000);
  // Thirty hide and show cycles in quick succession with all thirty deadlines due start no read themselves.
  for (let cycle = 0; cycle < 30; cycle += 1) await resume();
  expect(metadataReads()).toBe(0);
  const perTick = [];
  for (let step = 0; step < 33; step += 1) {
    const before = metadataReads();
    await resume();
    await advance(5_000);
    perTick.push(metadataReads() - before);
  }
  expect(Math.max(...perTick)).toBeLessThanOrEqual(1);
  expect(maxInFlight).toBe(1);
  // Every answer is applied, so each recording is read once and all of them close.
  expect(metadataReads()).toBe(30);
  expect(screen.queryByRole("button", { name: "Prepare recording" })).toBeNull();
});
