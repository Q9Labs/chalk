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
async function entry(code: string) {
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
      return Response.json({ error: { code, message: "Media proof was rejected" } }, { status: 401 });
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
        <SpacePage slug="design-lab" />
      </ThemeProvider>
    ),
  });
  const router = createRouter({ routeTree: root, history: createMemoryHistory({ initialEntries: [window.location.pathname + window.location.hash] }) });
  const container = document.createElement("div");
  document.body.appendChild(container);
  view = createRoot(container);
  await act(async () => view?.render(<RouterProvider router={router} />));
}

it("joins fresh when window.open inherits a copy of the reload marker", async () => {
  localStorage.setItem("chalk.display-name", "Ada");
  writeReloadRejoin(sessionStorage, marker);
  window.name = "";
  await entry("access.media_proof_rejected");
  await expectMessage("Asking to join Design Lab");
  expect(requests).toEqual(["fresh"]);
});

it.each([
  ["access.media_proof_rejected", "Could not return to this call. It may be open in another tab or device. Join as a new participant to continue here.", "Join as a new participant"],
  ["access.media_proof_expired", "Could not return to the Episode. Check your access before joining again.", "Ask again"],
])("offers fresh admission after %s without retrying replacement", async (code, message, label) => {
  writeReloadRejoin(sessionStorage, marker);
  await entry(code);
  await expectMessage(message);
  expect(requests).toEqual(["restore", "replace"]);
  const button = [...document.querySelectorAll("button")].find((candidate) => candidate.textContent === label);
  expect(button).toBeDefined();
  await act(async () => button?.click());
  await expectMessage("Asking to join Design Lab");
  expect(requests).toEqual(["restore", "replace", "fresh"]);
});

async function expectMessage(message: string) {
  await vi.waitFor(async () => {
    await act(async () => undefined);
    expect(document.body.textContent).toContain(message);
  });
}
