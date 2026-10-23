// @vitest-environment jsdom
import { act as reactAct, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Schema } from "effect";
import { RecordingSchema } from "@q9labsai/chalk-client/effect";
import type { ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { recordingDTO } from "../../../server/dto";
import { PastSessionPage } from "./PastSessionPage";

const router = vi.hoisted(() => ({ state: { location: { pathname: "/dashboard/call/space/session/episode" } } }));
vi.mock("@tanstack/react-router", () => ({ Link: ({ children }: { children: ReactNode }) => <a>{children}</a>, useRouter: () => router }));

type Cell = { readonly state: "capturing" | "ready"; readonly read: "readable" | "terminal" | "transient" };
const EXPORTS = { capturing: "unavailable", ready: "ready" };
const START = Date.parse("2026-10-22T12:00:00Z");
const uuid = (index: number) => `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`;
const date = (index: number) => new Date(START - index * 60_000).toISOString();
let cells: readonly Cell[];
let terminalStatus = 404;
let metadataReads: string[];
let calls: { readonly action?: string; readonly recordingId?: string; readonly download?: boolean }[];

function recording(cell: Cell, index: number) {
  return {
    ...recordingDTO(
      Schema.decodeUnknownSync(RecordingSchema)({
        id: uuid(index),
        tenant_id: uuid(0),
        space_id: uuid(0),
        episode_id: uuid(0),
        status: cell.state === "ready" ? "completed" : "pending",
        source: { status: cell.state === "capturing" ? "pending" : "available" },
        export: { status: EXPORTS[cell.state], retryable: false },
        // Transcription is independent of the video, and keeps every attempt in the paced metadata rotation.
        transcription_preparation: { status: "pending" },
        transcription_policy: "automatic",
        storage_provider: "r2",
        storage_key: null,
        metadata: {},
        created_at: date(index),
        updated_at: date(index),
      }),
    ),
    transcripts: [],
  };
}

async function route(input: string, init?: RequestInit): Promise<Response> {
  const url = new URL(input, "https://chalk.test");
  const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
  calls.push({ action: body?.action, recordingId: body?.recordingId, download: body?.download });
  const recordings = cells.map(recording);
  if (url.pathname === "/auth/session") return Response.json({ csrfToken: "fixture", profile: { name: "June", email: "june@example.test", avatarUrl: null } });
  if (url.pathname === "/dashboard-api/past-session") return Response.json({ callName: "Weekly sync", episode: { id: uuid(0), status: "ended", startedAt: date(0), endedAt: date(0) }, attendance: { kind: "available", participants: [] }, recordings, nextCursor: null });
  if (url.pathname === "/dashboard-api/call-metadata") {
    const index = recordings.findIndex((item) => item.id === url.searchParams.get("id"));
    metadataReads.push(uuid(index));
    const cell = cells[index];
    if (!cell) throw new Error("Unexpected recording");
    if (cell.read === "terminal") return Response.json({ error: { code: "recording_not_found" } }, { status: terminalStatus });
    if (cell.read === "transient") {
      if (index % 2) throw new TypeError("Network unavailable");
      return Response.json({ error: { code: "service_unavailable" } }, { status: 503 });
    }
    return Response.json({ kind: "recording", recording: recordings[index] });
  }
  if (body?.action === "recording-url") return Response.json({ url: `https://storage.example.test/${body.recordingId}.mp4` });
  if (body?.action === "export-recording") return Response.json({ recording: recordings.find((item) => item.id === body.recordingId) });
  throw new Error(`Unexpected request: ${url.pathname} ${body?.action}`);
}

beforeEach(() => {
  calls = [];
  terminalStatus = 404;
  metadataReads = [];
  vi.useFakeTimers();
  vi.setSystemTime(START);
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  vi.stubGlobal("fetch", async (input: string, init?: RequestInit) => {
    const response = await route(input, init);
    response.headers.set("Date", new Date().toUTCString());
    return response;
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it.each([404, 410])("keeps a readable capturing fallback after the newest metadata returns %s", async (status) => {
  cells = [
    { state: "capturing", read: "terminal" },
    { state: "capturing", read: "readable" },
  ];
  terminalStatus = status;
  await openAndRead();
  expect(metadataReads).toEqual([uuid(0), uuid(1)]);
  expect(screen.queryByText("Couldn’t load this recording")).toBeNull();
  expect(screen.getByText("Processing the recording")).toBeTruthy();
});

it("keeps the newest capturing attempt on a transient metadata failure", async () => {
  cells = [
    { state: "capturing", read: "transient" },
    { state: "capturing", read: "readable" },
  ];
  await openAndRead();
  expect(screen.queryByText("Couldn’t load this recording")).toBeNull();
  expect(screen.getByText("Processing the recording")).toBeTruthy();
});

it("offers the MP4 download for a readable ready export", async () => {
  cells = [{ state: "ready", read: "readable" }];
  await openAndRead();
  await reactAct(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Download" }));
  });
  expect(screen.getByRole("menuitem", { name: "Recording (MP4)" })).toBeTruthy();
});

it("requests the readable completed MP4 as a download", async () => {
  cells = [{ state: "ready", read: "readable" }];
  await openAndRead();
  await reactAct(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Download" }));
  });
  await reactAct(async () => {
    fireEvent.click(screen.getByRole("menuitem", { name: "Recording (MP4)" }));
  });
  expect(calls).toContainEqual({ action: "recording-url", recordingId: uuid(0), download: true });
});

async function openAndRead() {
  await reactAct(async () => {
    render(<PastSessionPage spaceId={uuid(0)} episodeId={uuid(0)} />);
  });
  for (let index = 0; index < cells.length; index++)
    await reactAct(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
}
