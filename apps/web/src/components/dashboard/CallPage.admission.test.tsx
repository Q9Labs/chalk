// @vitest-environment jsdom
import { act as reactAct, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { act } from "../../lib/dashboard/client";
import type { CallPageDTO } from "../../lib/dashboard/contracts";
import { CallPage } from "./CallPage";

const pending: CallPageDTO["knocks"][number] = { handle: "request-1", name: "June", requestedAt: "2026-10-21T00:00:00Z", expiresAt: "2026-10-21T00:05:00Z", state: "pending", decisionState: "none", decisionAction: null };
const initial: CallPageDTO = { call: { id: "space", name: "Call", slug: "call", admission: "knock", archived: false, createdAt: "2026-10-21T00:00:00Z" }, inviteUrl: "https://chalk.test/join/invite", episodes: [], live: null, nextCursor: null, knocks: [pending] };
let publish: (knocks: CallPageDTO["knocks"]) => void;

vi.mock("@tanstack/react-router", async () => {
  const { createElement } = await import("react");
  return { Link: ({ children }: { children: ReactNode }) => createElement("a", null, children), useNavigate: () => vi.fn() };
});
vi.mock("../../lib/dashboard/client", () => ({ act: vi.fn(async () => undefined), readPage: vi.fn(), errorMessage: String, admissionListUnavailable: () => false, needsSignIn: () => false }));
vi.mock("./AppShell", async () => {
  const { useCallback, useState } = await import("react");
  return {
    useLoad: () => {
      const [data, setData] = useState(initial);
      publish = (knocks) => setData((current) => ({ ...current, knocks }));
      const update = useCallback((change: (current: CallPageDTO) => CallPageDTO) => setData(change), []);
      return { state: { kind: "ready", data }, update, reload: vi.fn() };
    },
  };
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("an accepted click becomes busy, then the next failed/retryable server list enables a successful host retry", async () => {
  render(<CallPage spaceId="space" />);
  await reactAct(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Let in" }));
  });
  expect(act).toHaveBeenCalledTimes(1);
  // Prove retryability before checking the busy label so the historical sticky
  // decided-set fails for its actual bug: hiding a failed request indefinitely.
  reactAct(() => publish([{ ...pending, decisionState: "retryable" }]));
  const retry = screen.queryByRole<HTMLButtonElement>("button", { name: "Let in" });
  expect(retry, "failed server decision must become actionable again").not.toBeNull();
  expect(retry?.disabled).toBe(false);
  await reactAct(async () => {
    if (retry) fireEvent.click(retry);
  });
  expect(act).toHaveBeenCalledTimes(2);
  const busy = screen.getByRole<HTMLButtonElement>("button", { name: "Letting in…" });
  expect(busy.disabled).toBe(true);
  await reactAct(async () => {
    fireEvent.click(busy);
  });
  expect(act).toHaveBeenCalledTimes(2);
  for (let poll = 0; poll < 4; poll++) {
    reactAct(() => publish([{ ...pending, decisionState: "in_flight", decisionAction: "approve" }]));
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Letting in…" }).disabled).toBe(true);
  }
  reactAct(() => publish([]));
  expect(screen.queryByText("June")).toBeNull();
});
