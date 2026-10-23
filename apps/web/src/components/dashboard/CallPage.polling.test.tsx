// @vitest-environment jsdom
import { act as reactAct, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { act, DashboardRequestError, readPage } from "../../lib/dashboard/client";
import type { CallPageDTO } from "../../lib/dashboard/contracts";
import { CallPage } from "./CallPage";

const router = vi.hoisted(() => ({ state: { location: { pathname: "/dashboard/call/space" } }, navigate: vi.fn() }));
vi.mock("@tanstack/react-router", async () => {
  const { createElement } = await import("react");
  return { Link: ({ children }: { children: ReactNode }) => createElement("a", null, children), useNavigate: () => router.navigate, useRouter: () => router };
});
vi.mock("../../lib/dashboard/client", async (original) => {
  const client = await original<typeof import("../../lib/dashboard/client")>();
  return { ...client, act: vi.fn(), readPage: vi.fn() };
});

const pending: CallPageDTO["knocks"][number] = { handle: "request-1", name: "June", requestedAt: "2026-10-21T00:00:00Z", expiresAt: "2026-10-21T00:05:00Z", state: "pending", decisionState: "none", decisionAction: null };
const initial: CallPageDTO = { call: { id: "space", name: "Call", slug: "call", admission: "knock", archived: false, createdAt: "2026-10-21T00:00:00Z" }, inviteUrl: "https://chalk.test/join/invite", episodes: [], live: null, nextCursor: null, knocks: [] };

beforeEach(() => {
  vi.useFakeTimers();
  vi.resetAllMocks();
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it.each([403, 404, 410].flatMap((status) => ["recording", "transcript"].map((kind) => ({ status, kind }))))("removes an unavailable $kind after $status while retaining the Call and shared status polling", async ({ status, kind }) => {
  const episode = {
    id: "episode",
    status: "ended",
    startedAt: "2026-10-21T00:00:00Z",
    endedAt: "2026-10-21T00:05:00Z",
    participantCount: 1,
    recordingsNextCursor: null,
    recordings: [
      {
        id: "recording",
        status: kind === "recording" ? "pending" : "completed",
        sourceStatus: kind === "recording" ? "pending" : "available",
        exportStatus: kind === "recording" ? "unavailable" : "ready",
        exportRetryable: false,
        failureMessage: null,
        transcriptionStatus: "ready",
        sourceExpiresAt: null,
        transcriptionExpiresAt: null,
        createdAt: "2026-10-21T00:00:00Z",
        transcripts: [{ id: "transcript", status: "pending", languages: ["en"], createdAt: "2026-10-21T00:00:00Z" }],
      },
    ],
  } satisfies CallPageDTO["episodes"][number];
  vi.mocked(readPage)
    .mockResolvedValueOnce({ ...initial, episodes: [episode] })
    .mockResolvedValueOnce({ latestEpisodeId: episode.id, episode: null, knocks: [] })
    .mockResolvedValueOnce({ latestEpisodeId: episode.id, episode: null, knocks: [] })
    .mockRejectedValueOnce(new DashboardRequestError(status, "engine_not_found"))
    .mockResolvedValueOnce({ latestEpisodeId: episode.id, episode: null, knocks: [pending] });
  await reactAct(async () => {
    render(<CallPage spaceId="space" />);
  });
  expect(screen.getByText("Transcript processing")).toBeTruthy();
  await reactAct(async () => {
    await vi.advanceTimersByTimeAsync(10000);
  });
  expect(screen.queryByText("Couldn’t load this call")).toBeNull();
  expect(screen.queryByText("Transcript processing")).toBeNull();
  expect(screen.getByText(kind === "recording" ? "No recording" : "Recording", { exact: true })).toBeTruthy();
  await reactAct(async () => {
    await vi.advanceTimersByTimeAsync(5000);
  });
  expect(screen.getByText("June")).toBeTruthy();
  expect(vi.mocked(readPage).mock.calls.map(([page]) => page)).toEqual(["call", "call-status", "call-status", "call-metadata", "call-status"]);
});

it("uses the shared status tick for new knocks, accepted progress, retry and settlement without page reloads", async () => {
  vi.mocked(readPage)
    .mockResolvedValueOnce(initial)
    .mockResolvedValueOnce({ latestEpisodeId: null, episode: null, knocks: [pending] })
    .mockResolvedValueOnce({ latestEpisodeId: null, episode: null, knocks: [{ ...pending, decisionState: "in_flight", decisionAction: "approve" }] })
    .mockResolvedValueOnce({ latestEpisodeId: null, episode: null, knocks: [{ ...pending, decisionState: "retryable" }] })
    .mockResolvedValueOnce({ latestEpisodeId: null, episode: null, knocks: [] });
  await reactAct(async () => {
    render(<CallPage spaceId="space" />);
  });
  expect(screen.queryByText("June")).toBeNull();
  await reactAct(async () => {
    await vi.advanceTimersByTimeAsync(5000);
  });
  expect(screen.getByText("June")).toBeTruthy();
  await reactAct(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Let in" }));
  });
  expect(screen.getByRole<HTMLButtonElement>("button", { name: "Letting in…" }).disabled).toBe(true);
  await reactAct(async () => {
    await vi.advanceTimersByTimeAsync(3000);
  });
  expect(screen.getByRole<HTMLButtonElement>("button", { name: "Letting in…" }).disabled).toBe(true);
  await reactAct(async () => {
    await vi.advanceTimersByTimeAsync(3000);
  });
  const retry = screen.getByRole<HTMLButtonElement>("button", { name: "Let in" });
  expect(retry.disabled).toBe(false);
  await reactAct(async () => {
    fireEvent.click(retry);
  });
  await reactAct(async () => {
    await vi.advanceTimersByTimeAsync(3000);
  });
  expect(screen.queryByText("June")).toBeNull();
  expect(act).toHaveBeenCalledTimes(2);
  expect(vi.mocked(readPage).mock.calls.map(([page]) => page)).toEqual(["call", "call-status", "call-status", "call-status", "call-status"]);
});

it("doesn't poll an ended call when this page's clock runs past a deadline the server still reports open", async () => {
  vi.setSystemTime(new Date("2026-10-22T12:00:00Z"));
  // The recording's windows closed a minute ago by this page's clock, but the server still serves them, so its clock is behind.
  const episode = {
    id: "episode",
    status: "ended",
    startedAt: "2026-10-21T00:00:00Z",
    endedAt: "2026-10-21T00:05:00Z",
    participantCount: 1,
    recordingsNextCursor: null,
    recordings: [
      {
        id: "recording",
        status: "completed",
        sourceStatus: "available",
        exportStatus: "ready",
        exportRetryable: false,
        failureMessage: null,
        transcriptionStatus: "ready",
        sourceExpiresAt: "2026-10-22T11:59:00Z",
        transcriptionExpiresAt: "2026-10-22T11:59:00Z",
        createdAt: "2026-10-21T00:00:00Z",
        transcripts: [{ id: "transcript", status: "completed", languages: ["en"], createdAt: "2026-10-21T00:00:00Z" }],
      },
    ],
  } satisfies CallPageDTO["episodes"][number];
  vi.mocked(readPage).mockResolvedValueOnce({ ...initial, call: { ...initial.call, admission: "anyone" }, episodes: [episode] });
  await reactAct(async () => {
    render(<CallPage spaceId="space" />);
  });
  await reactAct(async () => {
    await vi.advanceTimersByTimeAsync(60_000);
  });
  expect(vi.mocked(readPage).mock.calls.map(([page]) => page)).toEqual(["call"]);
});

it("keeps fresh recording fields and the previous transcript list while retrying only a failed list", async () => {
  const recording = {
    id: "recording",
    status: "pending",
    sourceStatus: "available",
    exportStatus: "pending",
    exportRetryable: false,
    failureMessage: null,
    transcriptionStatus: "pending",
    sourceExpiresAt: null,
    transcriptionExpiresAt: null,
    createdAt: "2026-10-21T00:00:00Z",
  } satisfies CallPageDTO["episodes"][number]["recordings"][number];
  const transcript = { id: "transcript", status: "preparing", languages: ["en"], createdAt: "2026-10-21T00:05:00Z" };
  const episode = { id: "episode", status: "ended", startedAt: "2026-10-21T00:00:00Z", endedAt: "2026-10-21T00:05:00Z", participantCount: 1, recordingsNextCursor: null, recordings: [{ ...recording, transcripts: [transcript] }] } satisfies CallPageDTO["episodes"][number];
  const status = { latestEpisodeId: episode.id, episode: null, knocks: [] };
  vi.mocked(readPage)
    .mockResolvedValueOnce({ ...initial, call: { ...initial.call, admission: "anyone" }, episodes: [episode] })
    .mockResolvedValueOnce(status)
    .mockResolvedValueOnce(status)
    .mockResolvedValueOnce({ kind: "recording", recording: { ...recording, status: "completed", exportStatus: "ready", transcriptionStatus: "ready" } })
    .mockResolvedValue(status);
  vi.mocked(act)
    .mockRejectedValueOnce(new DashboardRequestError(503, "service_unavailable"))
    .mockResolvedValueOnce({ transcripts: [{ ...transcript, status: "complete" }] });
  await reactAct(async () => {
    render(<CallPage spaceId="space" />);
  });
  for (let second = 5; second <= 20; second += 5)
    await reactAct(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
  expect(screen.getByText("Transcript processing")).toBeTruthy();
  expect(vi.mocked(readPage).mock.calls.filter(([page]) => page === "call-metadata")).toHaveLength(1);
  expect(vi.mocked(act).mock.calls).toEqual([["past-session", { action: "transcripts", spaceId: "space", episodeId: "episode", recordingId: "recording", view: "call" }]]);
  for (let second = 25; second <= 40; second += 5)
    await reactAct(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
  expect(screen.queryByText("Transcript processing")).toBeNull();
  expect(screen.getByText("Transcript", { exact: true })).toBeTruthy();
  expect(vi.mocked(readPage).mock.calls.filter(([page]) => page === "call-metadata")).toHaveLength(1);
  expect(act).toHaveBeenCalledTimes(2);
});

it("reads an idle Call overview at most once per period across repeated tab resumes, and never over a read in flight", async () => {
  let visibility: DocumentVisibilityState = "visible";
  vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
  let resolveStatus: (value: Awaited<ReturnType<typeof readPage>>) => void = () => {};
  vi.mocked(readPage)
    .mockResolvedValueOnce({ ...initial, call: { ...initial.call, admission: "anyone" } })
    .mockImplementationOnce(() => new Promise((resolve) => (resolveStatus = resolve)))
    .mockResolvedValue({ latestEpisodeId: null, episode: null, knocks: [] });
  await reactAct(async () => {
    render(<CallPage spaceId="space" />);
  });
  async function resume() {
    for (const next of ["hidden", "visible"] as const) {
      visibility = next;
      await reactAct(async () => {
        document.dispatchEvent(new Event("visibilitychange"));
      });
    }
  }
  const pages = () => vi.mocked(readPage).mock.calls.map(([page]) => page);
  for (let cycle = 0; cycle < 10; cycle += 1) await resume();
  expect(pages()).toEqual(["call", "call-status"]);
  // A resume after the period still waits for the read in flight.
  await reactAct(async () => {
    await vi.advanceTimersByTimeAsync(5000);
  });
  await resume();
  expect(pages()).toEqual(["call", "call-status"]);
  await reactAct(async () => {
    resolveStatus({ latestEpisodeId: null, episode: null, knocks: [] });
  });
  await reactAct(async () => {
    await vi.advanceTimersByTimeAsync(5000);
  });
  await resume();
  expect(pages()).toEqual(["call", "call-status", "call-status"]);
});

it.each([403, 404, 410].flatMap((statusCode) => [false, true].map((previous) => ({ statusCode, previous }))))("keeps the Call page after list $statusCode (previous list: $previous) and retires the retry", async ({ statusCode, previous }) => {
  const recording = {
    id: "recording",
    status: "completed",
    sourceStatus: "available",
    exportStatus: "ready",
    exportRetryable: false,
    failureMessage: null,
    transcriptionStatus: "ready",
    sourceExpiresAt: null,
    transcriptionExpiresAt: null,
    createdAt: "2026-10-21T00:00:00Z",
  } satisfies CallPageDTO["episodes"][number]["recordings"][number];
  const episode = {
    id: "episode",
    status: "ended",
    startedAt: "2026-10-21T00:00:00Z",
    endedAt: "2026-10-21T00:05:00Z",
    participantCount: 1,
    recordingsNextCursor: null,
    recordings: [previous ? { ...recording, status: "pending", transcripts: [{ id: "previous", status: "preparing", languages: ["en"], createdAt: recording.createdAt }] } : recording],
  } satisfies CallPageDTO["episodes"][number];
  const status = { latestEpisodeId: episode.id, episode: null, knocks: [] };
  vi.mocked(readPage)
    .mockResolvedValueOnce({ ...initial, call: { ...initial.call, admission: "anyone" }, episodes: [episode] })
    .mockImplementation(async (page) => (page === "call-metadata" ? { kind: "recording", recording } : status));
  vi.mocked(act).mockRejectedValue(new DashboardRequestError(statusCode, "recording_not_found"));
  await reactAct(async () => {
    render(<CallPage spaceId="space" />);
  });
  for (let second = 5; second <= 20; second += 5)
    await reactAct(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
  expect(act).toHaveBeenCalledTimes(1);
  expect(vi.mocked(readPage).mock.calls.filter(([page]) => page === "call-metadata")).toHaveLength(previous ? 1 : 0);
  expect(screen.queryByText("Couldn’t load this call")).toBeNull();
  expect(screen.getByText("Transcript unavailable")).toBeTruthy();
  expect(screen.getByRole("heading", { name: initial.call.name })).toBeTruthy();
  for (let second = 25; second <= 60; second += 5)
    await reactAct(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
  expect(act).toHaveBeenCalledTimes(1);
  expect(vi.mocked(readPage).mock.calls.filter(([page]) => page === "call-metadata")).toHaveLength(previous ? 1 : 0);
  expect(screen.getByText("Transcript unavailable")).toBeTruthy();
});
