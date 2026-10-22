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
    recordings: [{ id: "recording", status: kind === "recording" ? "processing" : "completed", exportStatus: "completed", transcriptionPending: false, createdAt: "2026-10-21T00:00:00Z", transcripts: [{ id: "transcript", status: "pending", languages: ["en"], createdAt: "2026-10-21T00:00:00Z" }] }],
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
