/* @vitest-environment jsdom */
/// <reference types="vitest/jsdom" />

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const startOwnedCall = vi.hoisted(() => vi.fn());
const joinCall = vi.hoisted(() => vi.fn());
const pendingJoin = vi.hoisted(() => ({ value: null as string | null }));
const home = vi.hoisted(() => ({ reload: vi.fn(), more: undefined as undefined | { load: (cursor: string) => Promise<unknown> }, readPage: vi.fn() }));

vi.mock("./language-choice", () => ({ newCallIntent: () => "intent", startCall: startOwnedCall }));
vi.mock("./join-call", () => ({ useJoinCall: () => joinCall, usePendingJoin: () => pendingJoin.value }));
vi.mock("./use-dashboard", () => ({
  useLoad: () => ({
    state: { kind: "ready", data: { rows: home.more ? [{ id: "s1", name: "Call", archived: false, createdAt: "2026-11-21T10:00:00Z", lastActiveAt: null, live: null }] : [], nextCursor: "c1" } },
    reload: home.reload,
    update: () => {},
  }),
}));
vi.mock("../../lib/dashboard/client", async (importOriginal) => ({ ...(await importOriginal<typeof import("../../lib/dashboard/client")>()), readPage: home.readPage }));
vi.mock("./kit", () => ({
  MoreButton: (props: { load: (cursor: string) => Promise<unknown> }) => {
    home.more = props;
    return null;
  }, SkeletonRows: () => null, useToast: () => () => {} }));
vi.mock("./HomeRow", () => ({ CallRow: () => null }));
vi.mock("./HomeDialogs", () => ({ JoinLinkField: () => null, RenameDialog: () => null }));
vi.mock("../site/Icon", () => ({ Icon: () => null }));

import { DashboardRequestError } from "../../lib/dashboard/client";
import { HomePage } from "./HomePage";

let view: ReturnType<typeof createRoot> | undefined;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  startOwnedCall.mockReset().mockResolvedValue({ call: { id: "s1", name: "Call", archived: false, admission: "knock", createdAt: "2026-11-21T10:00:00Z", slug: "call-1" } });
  joinCall.mockReset();
  pendingJoin.value = null;
  home.reload.mockReset();
  home.readPage.mockReset();
  home.more = undefined;
});
afterEach(async () => {
  await act(async () => view?.unmount());
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

async function render() {
  const host = document.body.appendChild(document.createElement("div"));
  view = createRoot(host);
  await act(async () => view?.render(<HomePage />));
  const button = [...host.querySelectorAll("button")].find((item) => item.textContent?.includes("Start a call"));
  if (!button) throw new Error("Start a call is missing");
  return { host, button, rerender: () => act(async () => view?.render(<HomePage />)) };
}

it("starts one call however often Start a call is pressed while the call page is still opening", async () => {
  const { button, rerender } = await render();
  await act(async () => button.click());
  expect(startOwnedCall).toHaveBeenCalledTimes(1);
  expect(joinCall).toHaveBeenCalledTimes(1);
  // The call exists and the join route is still loading: the button spins, says it is disabled, and starts nothing.
  pendingJoin.value = "s1";
  await rerender();
  expect(button.getAttribute("aria-busy")).toBe("true");
  expect(button.getAttribute("aria-disabled")).toBe("true");
  await act(async () => button.click());
  expect(startOwnedCall).toHaveBeenCalledTimes(1);
});

it("reloads Home from the top when Show more is refused a cursor from another order", async () => {
  home.more = { load: async () => undefined };
  await render();
  await act(async () => view?.render(<HomePage />));
  home.readPage.mockRejectedValue(new DashboardRequestError(400, "invalid_cursor"));
  await expect(home.more?.load("old")).rejects.toThrow("invalid_cursor");
  expect(home.reload).toHaveBeenCalledTimes(1);
});
