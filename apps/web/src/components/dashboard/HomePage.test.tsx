/* @vitest-environment jsdom */
/// <reference types="vitest/jsdom" />

import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } from "@tanstack/react-router";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { HomeCallDTO, HomeDTO } from "../../lib/dashboard/contracts";
import { HomePage } from "./HomePage";
import { ToastProvider } from "./kit";

const call = (id: string, name: string): HomeCallDTO => ({ id, name, archived: false, admission: "knock", createdAt: "2026-11-21T10:00:00Z", slug: id, inviteUrl: null, lastActiveAt: null, recentPeople: [] });
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/** The dashboard's server, faked at the network edge: what it was asked, and what each Home read answers. */
function server() {
  const asked: string[] = [];
  const homeReads: HomeDTO[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    asked.push(`${init?.method ?? "GET"} ${url}`);
    if (url === "/auth/session") return json(200, { csrfToken: "csrf", profile: { id: "p1", name: "Alex" } });
    if (url.includes("cursor=")) return json(400, { error: { code: "invalid_cursor" } });
    if (url === "/dashboard-api/home" && init?.method === "POST") return json(200, { call: call("s2", "New call") });
    if (url.startsWith("/dashboard-api/home")) return json(200, homeReads.shift() ?? { calls: [], live: [], nextCursor: null });
    return json(404, { error: { code: "not_found" } });
  });
  return { asked, homeReads, started: () => asked.filter((request) => request === "POST /dashboard-api/home").length };
}

let view: ReturnType<typeof createRoot> | undefined;
let finishJoinRoute = () => {};

async function openHome() {
  const root = createRootRoute();
  const home = createRoute({
    getParentRoute: () => root,
    path: "/dashboard",
    component: () => (
      <ToastProvider>
        <HomePage />
      </ToastProvider>
    ),
  });
  const joining = createRoute({
    getParentRoute: () => root,
    path: "/dashboard/call/$spaceId/join",
    loader: () => new Promise<void>((resolve) => (finishJoinRoute = resolve)),
    component: () => <p>Joining the call</p>,
  });
  const router = createRouter({ routeTree: root.addChildren([home, joining]), history: createMemoryHistory({ initialEntries: ["/dashboard"] }) });
  const host = document.body.appendChild(document.createElement("div"));
  view = createRoot(host);
  await act(async () => view?.render(<RouterProvider router={router} />));
  await settle();
  return { host, router };
}

/** Lets the pending reads and route loads finish. */
const settle = () => act(async () => void (await new Promise((resolve) => setTimeout(resolve, 20))));
const buttonNamed = (host: HTMLElement, text: string) => {
  const button = [...host.querySelectorAll("button")].find((item) => item.textContent?.includes(text));
  if (!button) throw new Error(`${text} is missing`);
  return button;
};

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: false, media: query, addEventListener: () => {}, removeEventListener: () => {} }));
});
afterEach(async () => {
  await act(async () => view?.unmount());
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

it("starts one call however often Start a call is pressed while the call page is still opening", async () => {
  const dashboard = server();
  const { host, router } = await openHome();
  const button = buttonNamed(host, "Start a call");

  await act(async () => button.click());
  await settle();
  // The call exists and the join route is still loading: the button spins, says it is disabled, and starts nothing.
  expect(router.state.location.pathname).toBe("/dashboard/call/s2/join");
  expect(button.getAttribute("aria-busy")).toBe("true");
  expect(button.getAttribute("aria-disabled")).toBe("true");
  await act(async () => button.click());
  await settle();
  expect(dashboard.started()).toBe(1);

  await act(async () => finishJoinRoute());
  await settle();
  expect(host.textContent).toContain("Joining the call");
});

it("reloads Home from the top when Show more is refused a cursor from another order", async () => {
  const dashboard = server();
  dashboard.homeReads.push({ calls: [call("s1", "Old order call")], live: [], nextCursor: "old" }, { calls: [call("s3", "Fresh order call")], live: [], nextCursor: null });
  const { host } = await openHome();
  expect(host.textContent).toContain("Old order call");

  await act(async () => buttonNamed(host, "Show more calls").click());
  await settle();
  expect(host.textContent).toContain("Fresh order call");
  expect(host.textContent).not.toContain("Old order call");
});
