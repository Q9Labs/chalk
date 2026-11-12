/* @vitest-environment jsdom */

import { act } from "react";
import { createRoot } from "react-dom/client";
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from "@tanstack/react-router";
import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import { writeReloadRejoin } from "@q9labsai/chalk-client";
import { ThemeProvider } from "../../lib/theme-context";
import { SpacePage } from "./SpacePage";

const restoreCanvas = vi.hoisted(() => {
  const descriptor = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, "getContext");
  if (!descriptor) throw new Error("Missing canvas browser boundary");
  Object.defineProperty(HTMLCanvasElement.prototype, "getContext", { configurable: true, value: () => ({ filter: "none" }) });
  return () => Object.defineProperty(HTMLCanvasElement.prototype, "getContext", descriptor);
});
afterAll(restoreCanvas);
const marker = { space: "design-lab", episodeId: "33333333-3333-4333-8333-333333333333", participantId: "44444444-4444-4444-8444-444444444444", participantGeneration: 1, arrivalHandle: "initial-arrival", mediaProof: "stale-proof", displayName: "Ada", microphone: false, camera: false };
const freshArrival = { state: "pending", arrival_handle: "new-arrival", identity: "guest", retry_after: 60, space: { name: "Design Lab", slug: "design-lab", admission_mode: "approval" } };
const requests: string[] = [];
let view: ReturnType<typeof createRoot> | undefined;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  requests.length = 0;
  window.name = "";
  sessionStorage.clear();
  localStorage.clear();
  window.history.replaceState({}, "", "/space/design-lab#spaceInviteToken=cspi1.fixture"); // gitleaks:allow - inert invite fixture, not a credential
});
afterEach(async () => {
  await act(async () => view?.unmount());
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});
async function entry(code: string, slug: string | undefined = "design-lab", status = 401) {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const path = new URL(request.url).pathname;
    if (path === "/v1/public/space-invite-arrival" && request.method === "GET") {
      requests.push("restore");
      return Response.json({ ...freshArrival, state: "admitted", arrival_handle: marker.arrivalHandle });
    }
    if (path === "/v1/public/space-invite-arrival/access-grants") {
      requests.push("replace");
      expect(await request.json()).toMatchObject({ replace_media_connection: true });
      return Response.json({ error: { code, message: "Media proof was rejected" } }, { status });
    }
    if (path === "/v1/public/space-invite-arrivals") {
      requests.push("fresh");
      return Response.json(freshArrival, { status: 201 });
    }
    return Response.json({ error: { code: "auth.unauthorized", message: "Sign in required" } }, { status: 401 });
  });
  const root = createRootRoute({
    component: () => (
      <ThemeProvider>
        <SpacePage slug={slug} />
      </ThemeProvider>
    ),
  });
  const router = createRouter({ routeTree: root, history: createMemoryHistory({ initialEntries: [window.location.pathname + window.location.hash] }) });
  const container = document.createElement("div");
  document.body.appendChild(container);
  view = createRoot(container);
  await act(async () => view?.render(<RouterProvider router={router} />));
}

it("treats a window.open copy of the reload marker as a new entry: the device step shows and nothing is restored", async () => {
  localStorage.setItem("chalk.display-name", "Ada");
  localStorage.setItem("chalk.prejoin-devices", JSON.stringify({ microphone: false, camera: false }));
  writeReloadRejoin(sessionStorage, marker);
  window.name = "";
  await entry("access.media_proof_rejected");
  await expectMessage("Join call");
  expect(document.querySelector<HTMLInputElement>("#join-display-name")?.value).toBe("Ada");
  expect(requests).toEqual([]);
});

it.each([
  ["access.media_proof_rejected", "Join as a new participant"],
  ["access.media_proof_expired", "Ask again"],
])("offers fresh admission after %s without retrying replacement", async (code, label) => {
  writeReloadRejoin(sessionStorage, marker);
  await entry(code);
  const freshButton = () => [...document.querySelectorAll("button")].find((candidate) => candidate.textContent === label);
  await vi.waitFor(async () => {
    await act(async () => undefined);
    expect(freshButton()).toBeDefined();
  });
  expect(requests).toEqual(["restore", "replace"]);
  await act(async () => freshButton()?.click());
  await vi.waitFor(() => expect(requests).toEqual(["restore", "replace", "fresh"]));
});

it("says calls are unavailable when resuming after a reload returns 503 media.unavailable", async () => {
  writeReloadRejoin(sessionStorage, marker);
  await entry("media.unavailable", "design-lab", 503);
  await expectMessage("Calls are unavailable right now. Try again in a few minutes.");
  expect(requests).toEqual(["restore", "replace"]);
});

it("opens the Sync socket and API connection while the name prompt shows, without a request", async () => {
  document.head.querySelectorAll('link[rel="preconnect"]').forEach((link) => link.remove());
  const sockets: string[] = [];
  vi.stubGlobal(
    "WebSocket",
    class {
      readyState = 0;
      constructor(url: string) {
        sockets.push(url);
      }
      addEventListener() {}
      close() {}
    },
  );
  await entry("access.media_proof_rejected");
  await expectMessage("Join call");
  expect([...document.head.querySelectorAll('link[rel="preconnect"]')].map((link) => link.getAttribute("href"))).toContain(window.location.origin);
  expect(sockets).toHaveLength(1);
  expect(new URL(sockets[0] ?? "").pathname).toBe("/v1/sync");
  expect(requests).toEqual([]);
});

it("opens the device step for a saved name until the visitor has chosen devices", async () => {
  localStorage.setItem("chalk.display-name", "Ada");
  await entry("access.media_proof_rejected");
  await expectMessage("Join call");
  expect(document.querySelector<HTMLInputElement>("#join-display-name")?.value).toBe("Ada");
  expect(requests).toEqual([]);
});

async function expectMessage(message: string) {
  await vi.waitFor(async () => {
    await act(async () => undefined);
    expect(document.body.textContent).toContain(message);
  });
}

it.each([
  ["a new call", undefined, "/", "/v1/public/spaces"],
  ["an invite arrival", "design-lab", "/space/design-lab#spaceInviteToken=cspi1.fixture", "/v1/public/space-invite-arrivals"], // gitleaks:allow - inert invite fixture, not a credential
])("says calls are unavailable when %s returns 503 media.unavailable", async (_name, slug, url, path) => {
  window.history.replaceState({}, "", url);
  localStorage.setItem("chalk.display-name", "Ada");
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    if (request.method === "POST" && new URL(request.url).pathname === path) return Response.json({ error: { code: "media.unavailable", message: "Media plane is unavailable" } }, { status: 503 });
    return Response.json({ error: { code: "auth.unauthorized", message: "Sign in required" } }, { status: 401 });
  });
  const root = createRootRoute({
    component: () => (
      <ThemeProvider>
        <SpacePage slug={slug} />
      </ThemeProvider>
    ),
  });
  const router = createRouter({ routeTree: root, history: createMemoryHistory({ initialEntries: [url] }) });
  const container = document.createElement("div");
  document.body.appendChild(container);
  view = createRoot(container);
  await act(async () => view?.render(<RouterProvider router={router} />));
  const join = [...document.querySelectorAll("button")].find((candidate) => candidate.textContent === "Join call");
  await act(async () => join?.click());
  await expectMessage("Calls are unavailable right now. Try again in a few minutes.");
});
