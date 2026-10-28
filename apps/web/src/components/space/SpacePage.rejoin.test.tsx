/* @vitest-environment jsdom */

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } from "@tanstack/react-router";
import { afterAll, afterEach, expect, it, vi } from "vitest";
import { spacePageTestToken } from "../../__tests__/space-page.fixture";
import { ThemeProvider } from "../../lib/theme-context";
import { SpacePage } from "./SpacePage";

const restoreCanvas = vi.hoisted(() => {
  const descriptor = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, "getContext");
  if (!descriptor) throw new Error("Missing canvas browser boundary");
  Object.defineProperty(HTMLCanvasElement.prototype, "getContext", { configurable: true, value: () => ({ filter: "none" }) });
  return () => Object.defineProperty(HTMLCanvasElement.prototype, "getContext", descriptor);
});
afterAll(restoreCanvas);
const fetchBoundary = vi.fn<typeof fetch>();
afterEach(async () => {
  await act(async () => cleanup());
  vi.unstubAllGlobals();
});

it.each([false, true])("retries failed terminal cleanup before fresh admission (another outage: %s)", async (failsAgain) => {
  // The retained C4 outage frame shows both a terminal call and a failed Leave.
  // Exercise that state with real product modules; only network/browser APIs differ.
  window.history.replaceState({}, "", `/space/design-lab#spaceInviteToken=${spacePageTestToken}`);
  const storage = () => {
    const values = new Map<string, string>();
    return {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
      clear: () => values.clear(),
      key: (index: number) => [...values.keys()][index] ?? null,
      get length() {
        return values.size;
      },
    } satisfies Storage;
  };
  vi.stubGlobal("localStorage", storage());
  vi.stubGlobal("sessionStorage", storage());
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => setTimeout(() => callback(performance.now()), 0));
  vi.stubGlobal("cancelAnimationFrame", (handle: number) => clearTimeout(handle));
  vi.stubGlobal(
    "RTCPeerConnection",
    class {
      constructor() {
        throw new Error("Transport unavailable");
      }
    },
  );
  const departure = Promise.withResolvers<Response>();
  const requests: string[] = [];
  let arrivals = 0;
  let leaves = 0;
  fetchBoundary.mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    const path = new URL(request.url).pathname;
    if (path === "/v1/public/space-invite-arrivals") {
      requests.push("arrive");
      arrivals++;
      return Response.json(arrivals === 1 ? admittedArrival() : { state: "pending", arrival_handle: "next-arrival", identity: "guest", retry_after: 60, space: { name: "Design Lab", slug: "design-lab", admission_mode: "approval" } }, { status: 201 });
    }
    if (path === "/v1/public/space-invite-arrival" && request.method === "DELETE") {
      if (request.headers.get("X-Chalk-Arrival-Handle") === "next-arrival") return new Response(null, { status: 204 });
      requests.push("leave");
      leaves++;
      if (leaves === 1) throw new TypeError("Failed to fetch");
      return leaves === 2 ? departure.promise : new Response(null, { status: 204 });
    }
    return Response.json({ error: { code: "auth.unauthorized", message: "Sign in required" } }, { status: 401 });
  });
  vi.stubGlobal("fetch", fetchBoundary);
  const root = createRootRoute({
    component: () => (
      <ThemeProvider>
        <SpacePage slug="design-lab" />
      </ThemeProvider>
    ),
  });
  const route = createRoute({ getParentRoute: () => root, path: "/space/$slug" });
  const router = createRouter({ routeTree: root.addChildren([route]), history: createMemoryHistory({ initialEntries: [window.location.pathname + window.location.hash] }) });
  render(<RouterProvider router={router} />);
  fireEvent.change(await screen.findByLabelText("Your name"), { target: { value: "Ada" } });
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Join call" })));
  await screen.findByText("Couldn’t leave the call. Try Home again.");
  await act(async () => window.dispatchEvent(new Event("online")));
  const rejoin = screen.getByRole<HTMLButtonElement>("button", { name: "Try again", exact: true });
  expect(rejoin.disabled).toBe(false);
  await act(async () => fireEvent.click(rejoin));
  await waitFor(() => expect(leaves).toBe(2));
  expect(rejoin.disabled).toBe(true);
  expect(arrivals).toBe(1);
  if (failsAgain) {
    await act(async () => departure.reject(new TypeError("Failed to fetch")));
    await waitFor(() => expect(rejoin.disabled).toBe(false));
    expect(arrivals).toBe(1);
    await act(async () => fireEvent.click(rejoin));
  } else {
    await act(async () => departure.resolve(new Response(null, { status: 204 })));
  }
  await screen.findByText("Asking to join Design Lab");
  expect(requests).toEqual(failsAgain ? ["arrive", "leave", "leave", "leave", "arrive"] : ["arrive", "leave", "leave", "arrive"]);
});

function admittedArrival() {
  const token = (audience: string) => `${btoa(JSON.stringify({ alg: "EdDSA" }))}.${btoa(JSON.stringify({ aud: audience }))}.fixture`;
  const expires = new Date(Date.now() + 300_000).toISOString();
  return {
    state: "admitted",
    arrival_handle: "initial-arrival",
    identity: "guest",
    space: { name: "Design Lab", slug: "design-lab", admission_mode: "open" },
    access: {
      subject: { tenant_id: "11111111-1111-4111-8111-111111111111", space_id: "22222222-2222-4222-8222-222222222222", episode_id: "33333333-3333-4333-8333-333333333333", participant_id: "44444444-4444-4444-8444-444444444444", participant_generation: 1 },
      sync: { token: token("chalk-sync"), expires_at: expires },
      media: { token: token("chalk-media"), expires_at: expires, provider: "cloudflare_sfu", client_payload: { connectionId: "fixture", stunServer: "stun:example.test" } },
    },
  };
}
