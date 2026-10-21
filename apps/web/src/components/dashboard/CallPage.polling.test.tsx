// @vitest-environment jsdom
import { act as reactAct, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { act, readPage } from "../../lib/dashboard/client";
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
  vi.clearAllMocks();
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
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
