// @vitest-environment jsdom
import { act as reactAct, cleanup, render, screen } from "@testing-library/react";
import { Effect, Schema } from "effect";
import { createChalkEffectClient, TenantIdSchema } from "@q9labsai/chalk-client/effect";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { callMetadata } from "../../../server/call";
import type { Engine } from "../../../server/engine";
import { DashboardError } from "../../../server/http";
import { pastMutation, pastSessionPage } from "../../../server/past-session";
import { callMetadataQuery, pastAction } from "../../lib/dashboard/contracts";
import { PastSessionPage } from "./PastSessionPage";

// The page's model, driven through the real dashboard handlers and SDK over a fake Chalk API: every recording attempt
// and every transcript on it is tracked whether the page shows it or not, deadlines and rechecks run on the server's
// clock, and each read fails on its own.

const router = vi.hoisted(() => ({ state: { location: { pathname: "/dashboard/call/space/session/episode" } }, navigate: vi.fn() }));
vi.mock("@tanstack/react-router", async () => {
  const { createElement } = await import("react");
  return { Link: ({ children }: { children: ReactNode }) => createElement("a", null, children), useRouter: () => router };
});

const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
const TENANT = uuid(1);
const SPACE = uuid(2);
const EPISODE = uuid(3);
const ITEM = uuid(0xa1);
const OTHER = uuid(0xa2);
const TRANSCRIPT = uuid(0xb1);
const PAGE_START = Date.parse("2026-10-22T12:00:00Z");
const HOUR = 3_600_000;
const iso = (at: number) => new Date(at).toISOString();

type Item = "recording" | "transcript";
type Place = "selected" | "unselected";
type State = "pending" | "ready" | "transient failure" | "401" | "other 4xx" | "window closed early";
type Clock = "behind" | "ahead";
type Cell = { readonly item: Item; readonly place: Place; readonly state: State; readonly clock: Clock };

/**
 * What the page must do for each item, attempt and state; the clock never changes it. `polled` and `retried` count
 * reads of the item's attempt; `plays` names the attempt whose video is on screen at the end.
 */
type Expectation = {
  readonly polled: boolean;
  readonly retried: boolean;
  readonly shown: readonly string[];
  readonly hidden: readonly string[];
  readonly plays?: "item" | "other";
  /** Text on screen partway through: what loads during a failure, or an action that stays until the server's answer. */
  readonly midway?: { readonly at: number; readonly shown: readonly string[] };
  /** Codex review threads on ea0c66866 that this row answers. */
  readonly codex?: string;
};
const LOST = "Couldn’t load this recording";
const UNREAD = "Couldn’t load the transcript";
const SPEECH = "Item speech";
const CLOSED_VIDEO = "The recording is no longer available";
const CLOSED_TRANSCRIPT = "A transcript can no longer be made for this recording.";
const MAKE = "Make a transcript in English";
const SIGNED_OUT: Expectation = { polled: true, retried: false, shown: [], hidden: [] };

const TABLE: Record<Item, Record<Place, Record<State, Expectation>>> = {
  recording: {
    selected: {
      pending: { polled: true, retried: false, shown: [], hidden: ["Preparing the recording"], plays: "item" },
      ready: { polled: false, retried: false, shown: [], hidden: [], plays: "item" },
      "transient failure": { polled: true, retried: true, shown: [], hidden: [LOST], plays: "item", midway: { at: 10_000, shown: ["Preparing the recording", "Who came"] } },
      "401": SIGNED_OUT,
      "other 4xx": { polled: true, retried: false, shown: [LOST], hidden: ["Preparing the recording"] },
      "window closed early": { polled: true, retried: false, shown: [CLOSED_VIDEO], hidden: ["Prepare recording"], midway: { at: 120_000, shown: ["Prepare recording"] }, codex: "r4355336033" },
    },
    unselected: {
      pending: { polled: true, retried: false, shown: [], hidden: [], plays: "other" },
      ready: { polled: false, retried: false, shown: [], hidden: [], plays: "other" },
      "transient failure": { polled: true, retried: true, shown: [], hidden: [LOST], plays: "other" },
      "401": SIGNED_OUT,
      "other 4xx": { polled: true, retried: false, shown: [], hidden: [LOST], plays: "other" },
      "window closed early": { polled: true, retried: false, shown: [], hidden: ["Prepare recording"], plays: "other" },
    },
  },
  transcript: {
    selected: {
      pending: { polled: true, retried: false, shown: [SPEECH], hidden: [], plays: "item" },
      ready: { polled: false, retried: false, shown: [SPEECH], hidden: [], plays: "item" },
      "transient failure": { polled: true, retried: true, shown: [SPEECH], hidden: [UNREAD], plays: "item", midway: { at: 10_000, shown: [UNREAD, "Who came"] } },
      "401": { ...SIGNED_OUT, codex: "r4355336046" },
      "other 4xx": { polled: true, retried: false, shown: [UNREAD], hidden: [LOST], plays: "item" },
      "window closed early": { polled: true, retried: false, shown: [CLOSED_TRANSCRIPT], hidden: [MAKE], plays: "item", midway: { at: 120_000, shown: [MAKE] } },
    },
    unselected: {
      pending: { polled: true, retried: false, shown: [SPEECH], hidden: [], plays: "other", codex: "r4355336029" },
      ready: { polled: false, retried: false, shown: [SPEECH], hidden: [], plays: "other" },
      "transient failure": { polled: true, retried: true, shown: [SPEECH], hidden: [UNREAD], plays: "other", midway: { at: 10_000, shown: ["Who came"] }, codex: "r4355336039" },
      "401": SIGNED_OUT,
      "other 4xx": { polled: true, retried: false, shown: [UNREAD], hidden: [LOST], plays: "other" },
      "window closed early": { polled: true, retried: false, shown: [], hidden: [MAKE], plays: "other" },
    },
  },
};

let cell: Cell;
let engine: Engine;
let log: { readonly at: number; readonly path: string; readonly action?: string; readonly id?: string; readonly status: number }[];

// The page's clock runs an hour behind or ahead of the server's, which owns every deadline and every state change.
const skew = () => (cell.clock === "behind" ? HOUR : -HOUR);
const elapsed = () => Date.now() - PAGE_START;
const serverNow = () => Date.now() + skew();
const WINDOW_END = () => iso(PAGE_START + skew() + 3 * 24 * HOUR);
const finished = () => elapsed() >= 12_000;
const closedEarly = () => cell.state === "window closed early" && elapsed() >= 60_000;
const signedOut = () => cell.state === "401" && elapsed() >= 7_000;
const failing = () => (cell.state === "transient failure" && elapsed() < 20_000) || (cell.state === "other 4xx" && elapsed() >= 7_000);

function itemRecording() {
  const source = { status: "available", expires_at: WINDOW_END() };
  if (cell.item === "recording") {
    if (cell.state === "window closed early")
      return closedEarly()
        ? { status: "pending", source: { status: "expired" }, export: { status: "unavailable", retryable: false }, transcription_preparation: { status: "none" } }
        : { status: "pending", source, export: { status: "none", retryable: false }, transcription_preparation: { status: "none" } };
    const ready = cell.state === "ready" || finished();
    return { status: ready ? "completed" : "pending", source, export: { status: ready ? "ready" : "pending", retryable: false }, transcription_preparation: { status: "none" } };
  }
  // A transcript item's attempt plays when it is the selected one, and can only be prepared when it isn't.
  const video = cell.place === "selected" ? { status: "completed", export: { status: "ready", retryable: false } } : { status: "pending", export: { status: "none", retryable: false } };
  return { ...video, source, transcription_preparation: closedEarly() ? { status: "expired" } : { status: "ready", expires_at: WINDOW_END() } };
}

function itemTranscripts() {
  if (cell.item !== "transcript" || cell.state === "window closed early") return [];
  return [{ id: TRANSCRIPT, status: cell.state === "ready" || finished() ? "complete" : "transcribing" }];
}

/** Newest first. The other attempt plays when the item's isn't the selected one, and is long expired when it is. */
function attempts() {
  const item = { id: ITEM, ...itemRecording(), transcripts: itemTranscripts() };
  const other =
    cell.place === "selected"
      ? { id: OTHER, status: "completed", source: { status: "expired" }, export: { status: "unavailable", retryable: false }, transcription_preparation: { status: "none" }, transcripts: [] }
      : { id: OTHER, status: "completed", source: { status: "available", expires_at: WINDOW_END() }, export: { status: "ready", retryable: false }, transcription_preparation: { status: "none" }, transcripts: [] };
  const newestFirst = cell.item === "recording" && cell.place === "unselected" ? [other, item] : [item, other];
  return newestFirst.map((recording, index) => ({ ...recording, createdAt: iso(PAGE_START - (index + 1) * HOUR) }));
}

const common = { tenant_id: TENANT, space_id: SPACE, episode_id: EPISODE };
function recordingJSON({ transcripts: _transcripts, createdAt, ...recording }: ReturnType<typeof attempts>[number]) {
  return { ...recording, ...common, transcription_policy: "automatic", storage_provider: "r2", storage_key: null, metadata: {}, created_at: createdAt, updated_at: createdAt };
}
function transcriptJSON(recordingId: string, transcript: { id: string; status: string }) {
  return { ...common, ...transcript, recording_id: recordingId, generation: 1, languages: ["en"], created_at: iso(PAGE_START), updated_at: iso(PAGE_START) };
}
const page = (size: number) => ({ has_more: false, next_cursor: null, page_size: size });
const apiError = (status: number, code: string) => Response.json({ error: { code, message: code } }, { status });

/** The Chalk API, as the dashboard's SDK client calls it. */
async function chalkAPI(input: RequestInfo | URL): Promise<Response> {
  const url = new URL(input instanceof Request ? input.url : String(input));
  const path = url.pathname.replace(`/v1/tenants/${TENANT}`, "");
  // A refusal as each endpoint declares one: a missing recording, or a list the tenant may no longer read.
  const failure = cell.state === "transient failure" ? apiError(503, "service.unavailable") : cell.item === "recording" ? apiError(404, "recording.not_found") : apiError(403, "access.forbidden");
  if (path === `/spaces/${SPACE}/episodes/${EPISODE}`)
    return Response.json({
      ...common,
      id: EPISODE,
      status: "ended",
      config_snapshot: {},
      metadata: {},
      deadline_generation: 0,
      created_at: iso(PAGE_START - 2 * HOUR),
      deadline_at: iso(PAGE_START),
      started_at: iso(PAGE_START - 2 * HOUR),
      ended_at: iso(PAGE_START - HOUR),
      updated_at: iso(PAGE_START),
    });
  if (path === `/spaces/${SPACE}/episodes/${EPISODE}/attendance`)
    return Response.json({ episode_id: EPISODE, participants: [{ participant_id: uuid(0xc1), display_name: "June Park", external_id: null, identity_kind: "user", first_joined_at: iso(PAGE_START - 2 * HOUR), last_left_at: iso(PAGE_START - HOUR), left_reason: "left" }] });
  if (path === "/recordings") return Response.json({ pagination: page(30), recordings: attempts().map(recordingJSON) });
  const recording = attempts().find((item) => path === `/recordings/${item.id}`);
  if (recording) return cell.item === "recording" && recording.id === ITEM && failing() ? failure : Response.json(recordingJSON(recording));
  if (path === "/transcripts") {
    const owner = attempts().find((item) => item.id === url.searchParams.get("recording_id"));
    if (!owner) return apiError(404, "recording.not_found");
    if (cell.item === "transcript" && owner.id === ITEM && failing()) return failure;
    return Response.json({ pagination: page(30), transcripts: owner.transcripts.map((transcript) => transcriptJSON(owner.id, transcript)) });
  }
  if (path === `/transcripts/${TRANSCRIPT}`) return Response.json(transcriptJSON(ITEM, itemTranscripts()[0] ?? { id: TRANSCRIPT, status: "deleted" }));
  if (path === `/transcripts/${TRANSCRIPT}/document`) return Response.json({ episode_id: EPISODE, recording_id: ITEM, transcript_id: TRANSCRIPT, schema_version: "1", cues: [{ start_ms: 0, end_ms: 1_000, overlap: false, text: SPEECH }] });
  throw new Error(`Unexpected Chalk API request: ${path}`);
}

/** The dashboard's Pages Functions for this page: the real handlers, with the server's error shape and clock. */
async function dashboardAPI(input: string, init?: RequestInit): Promise<Response> {
  const url = new URL(input, "https://chalk.test");
  const body: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : null;
  const action = body && typeof body === "object" && "action" in body && typeof body.action === "string" ? body.action : undefined;
  const target = body && typeof body === "object" && "recordingId" in body && typeof body.recordingId === "string" ? body.recordingId : (url.searchParams.get("id") ?? undefined);
  const response = await answer(url, init?.method === "POST" ? body : null);
  response.headers.set("Date", new Date(serverNow()).toUTCString());
  log.push({ at: elapsed(), path: url.pathname, action, id: target, status: response.status });
  return response;
}

async function answer(url: URL, body: unknown): Promise<Response> {
  if (signedOut()) return Response.json({ error: { code: "sign_in_required" } }, { status: 401 });
  if (url.pathname === "/auth/session") return Response.json({ csrfToken: "fixture", profile: { name: "June Park", email: "june@example.test", avatarUrl: null } });
  try {
    if (url.pathname === "/dashboard-api/call") return Response.json({ call: { name: "Weekly sync" } });
    if (url.pathname === "/dashboard-api/call-metadata") return Response.json(await callMetadata(engine, callMetadataQuery.parse(Object.fromEntries(url.searchParams))));
    if (url.pathname === "/dashboard-api/past-session" && body === null) return Response.json(await pastSessionPage(engine, SPACE, EPISODE));
    const action = pastAction.parse(body);
    if (action.action === "recording-url") return Response.json({ url: `https://storage.test/${action.recordingId}.mp4`, expiresAt: iso(serverNow() + 300_000), method: "GET", headers: {} });
    return Response.json(await pastMutation(engine, action));
  } catch (error) {
    if (!(error instanceof DashboardError)) throw error;
    return Response.json({ error: { code: error.code } }, { status: error.status });
  }
}

beforeEach(async () => {
  engine = { api: await Effect.runPromise(createChalkEffectClient({ baseUrl: "https://api.chalk.test", fetch: chalkAPI })), tenantId: Schema.decodeUnknownSync(TenantIdSchema)(TENANT), dashboardOrigin: "https://chalk.test" };
  log = [];
  router.navigate.mockClear();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  vi.setSystemTime(PAGE_START);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  vi.stubGlobal("fetch", dashboardAPI);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function until(at: number) {
  // One render per tick, as a browser renders between timers.
  while (elapsed() < at)
    await reactAct(async () => {
      await vi.advanceTimersByTimeAsync(Math.min(5_000, at - elapsed()));
    });
}

const itemReads = () => log.filter((entry) => entry.id === ITEM && (entry.path === "/dashboard-api/call-metadata" || entry.action === "transcripts"));
const videos = () => log.filter((entry) => entry.action === "recording-url").map((entry) => entry.id);

const CELLS = (["recording", "transcript"] as const).flatMap((item) =>
  (["selected", "unselected"] as const).flatMap((place) =>
    (["pending", "ready", "transient failure", "401", "other 4xx", "window closed early"] as const).flatMap((state) =>
      (["behind", "ahead"] as const).map((clock): [string, Cell] => {
        const codex = TABLE[item][place][state].codex;
        return [`${item} · ${place} · ${state} · clock ${clock}${codex ? ` (Codex ${codex})` : ""}`, { item, place, state, clock }];
      }),
    ),
  ),
);

describe("the past-session page tracks every item on the server's clock", () => {
  it.each(CELLS)("%s", async (_title, value) => {
    cell = value;
    const expected = TABLE[cell.item][cell.place][cell.state];
    await reactAct(async () => {
      render(<PastSessionPage spaceId={SPACE} episodeId={EPISODE} />);
    });
    if (expected.midway) {
      await until(expected.midway.at);
      expect(screen.queryByText("Couldn’t load this session")).toBeNull();
      for (const text of expected.midway.shown) expect(screen.getByText(text)).toBeTruthy();
    }
    await until(cell.state === "window closed early" ? 310_000 : 60_000);

    const reads = itemReads();
    expect(reads.length > 0).toBe(expected.polled);
    const firstFailure = reads.findIndex((entry) => entry.status >= 400);
    expect(firstFailure >= 0 && firstFailure < reads.length - 1).toBe(expected.retried);
    expect(screen.queryByText("Couldn’t load this session")).toBeNull();
    if (cell.state === "401") {
      // The lost session goes to sign-in once, and nothing is read after its answer.
      expect(router.navigate).toHaveBeenCalledOnce();
      expect(router.navigate).toHaveBeenCalledWith(expect.objectContaining({ to: "/dashboard/sign-in" }));
      const lost = log.findIndex((entry) => entry.status === 401);
      expect(log.slice(lost + 1)).toEqual([]);
      return;
    }
    expect(router.navigate).not.toHaveBeenCalled();
    // A refused read is final for that item: nothing reads it again.
    if (cell.state === "other 4xx") expect(reads.slice(firstFailure + 1)).toEqual([]);
    for (const text of expected.shown) expect(screen.getByText(text)).toBeTruthy();
    for (const text of expected.hidden) expect(screen.queryByText(text)).toBeNull();
    if (expected.plays) {
      expect(screen.getByRole("region", { name: "Recording" })).toBeTruthy();
      expect(videos().at(-1)).toBe(expected.plays === "item" ? ITEM : OTHER);
    }
  });
});
