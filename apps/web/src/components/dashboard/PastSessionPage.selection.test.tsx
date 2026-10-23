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

const STATES = ["capturing", "rendering", "preparable", "ready", "failed"] as const;
const READS = ["readable", "terminal", "transient"] as const;
type Cell = { readonly state: (typeof STATES)[number]; readonly read: (typeof READS)[number] };
const EXPORTS = { capturing: "unavailable", rendering: "pending", preparable: "none", ready: "ready", failed: "failed" } satisfies Record<Cell["state"], string>;
const TITLES = { capturing: "Processing the recording", rendering: "Preparing the recording", preparable: "The recording is ready to prepare", ready: null, failed: "The recording couldn’t be prepared" } satisfies Record<Cell["state"], string | null>;
const OPTIONS = STATES.flatMap((state) => READS.map((read): Cell => ({ state, read })));
const START = Date.parse("2026-10-22T12:00:00Z");
const uuid = (index: number) => `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`;
const date = (index: number) => new Date(START - index * 60_000).toISOString();
let cells: readonly Cell[];
let metadataReads: string[];
let calls: { readonly action?: string; readonly recordingId?: string }[];

function combinations(count: number): Cell[][] {
  let rows: Cell[][] = [[]];
  for (let index = 0; index < count; index++) rows = rows.flatMap((row) => OPTIONS.map((cell) => [...row, cell]));
  return rows;
}

const MATRIX = [2, 3].flatMap(combinations).map((row): [string, readonly Cell[]] => [row.map(({ state, read }) => `${state}/${read}`).join(" > "), row]);

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
    transcriptsNextCursor: null,
  };
}

async function route(input: string, init?: RequestInit): Promise<Response> {
  const url = new URL(input, "https://chalk.test");
  const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
  calls.push({ action: body?.action, recordingId: body?.recordingId });
  const recordings = cells.map(recording);
  if (url.pathname === "/auth/session") return Response.json({ csrfToken: "fixture", profile: { name: "June", email: "june@example.test", avatarUrl: null } });
  if (url.pathname === "/dashboard-api/past-session") return Response.json({ callName: "Weekly sync", episode: { id: uuid(0), status: "ended", startedAt: date(0), endedAt: date(0) }, attendance: { kind: "available", participants: [] }, recordings, nextCursor: null });
  if (url.pathname === "/dashboard-api/call-metadata") {
    const index = recordings.findIndex((item) => item.id === url.searchParams.get("id"));
    metadataReads.push(uuid(index));
    const cell = cells[index];
    if (!cell) throw new Error("Unexpected recording");
    if (cell.read === "terminal") return Response.json({ error: { code: "recording_not_found" } }, { status: index % 2 ? 410 : 404 });
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

it.each(MATRIX)("selects the recording and its actions: %s", async (_title, row) => {
  cells = row;
  await reactAct(async () => {
    render(<PastSessionPage spaceId={uuid(0)} episodeId={uuid(0)} />);
  });
  for (let index = 0; index < row.length; index++)
    await reactAct(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });

  expect(metadataReads).toEqual(row.map((_cell, index) => uuid(index)));

  // Expected behavior is stated in terms of the fixture states, independently of the production selectors.
  const available = row.map((cell, index) => ({ ...cell, index })).filter((cell) => cell.read !== "terminal");
  const actionable = (cell: Cell) => cell.state === "preparable" || cell.state === "rendering";
  const chosen = available.find((cell) => cell.state === "ready") ?? available.find(actionable) ?? available[0];
  const newer = chosen?.state === "ready" ? available.find((cell) => cell.index < chosen.index && actionable(cell)) : undefined;
  const title = chosen ? TITLES[chosen.state] : "Couldn’t load this recording";
  const titles = ["Couldn’t load this recording", "Processing the recording", "Preparing the recording", "The recording is ready to prepare", "The recording couldn’t be prepared"];
  if (!chosen) expect(screen.getByText("Couldn’t load this recording").parentElement?.textContent).toContain("This isn’t here anymore. It may have been archived.");
  for (const text of titles) expect(Boolean(screen.queryByText(text))).toBe(text === title);
  expect(Boolean(screen.queryByRole("region", { name: "Recording" }))).toBe(chosen?.state === "ready");
  if (chosen?.state === "ready") expect(calls.filter((call) => call.action === "recording-url").at(-1)?.recordingId).toBe(uuid(chosen.index));

  const prepare = chosen?.state === "preparable" ? chosen : newer?.state === "preparable" ? newer : undefined;
  expect(Boolean(screen.queryByRole("button", { name: "Prepare recording" }))).toBe(prepare !== undefined);
  expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
  expect(screen.queryByRole("button", { name: /^Make a transcript/ })).toBeNull();
  expect(Boolean(screen.queryByText("Preparing the newer recording"))).toBe(newer?.state === "rendering");
  expect(Boolean(screen.queryByText("A newer recording is ready to prepare"))).toBe(newer?.state === "preparable");
  if (prepare) {
    await reactAct(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Prepare recording" }));
    });
    expect(calls.filter((call) => call.action === "export-recording").at(-1)?.recordingId).toBe(uuid(prepare.index));
  }
  expect(Boolean(screen.queryByRole("button", { name: "Download" }))).toBe(chosen?.state === "ready");
  if (chosen?.state === "ready") {
    await reactAct(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Download" }));
    });
    expect(screen.getByRole("menuitem", { name: "Recording (MP4)" })).toBeTruthy();
  }
});
