/* @vitest-environment jsdom */

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } from "@tanstack/react-router";
import { afterAll, afterEach, expect, it, vi } from "vitest";
import { ThemeProvider } from "../../lib/theme-context";
import { SpacePage } from "./SpacePage";

const restoreCanvas = vi.hoisted(() => {
  const descriptor = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, "getContext");
  if (!descriptor) throw new Error("Missing canvas browser boundary");
  Object.defineProperty(HTMLCanvasElement.prototype, "getContext", { configurable: true, value: () => ({ filter: "none" }) });
  return () => Object.defineProperty(HTMLCanvasElement.prototype, "getContext", descriptor);
});
afterAll(restoreCanvas);

let responseCode = "space_public_invite.unavailable";
const fetch = vi.fn(async (input: RequestInfo | URL) => {
  const url = input instanceof Request ? input.url : String(input);
  if (url.endsWith("/v1/public/space-invite-arrivals")) return Response.json({ error: { code: responseCode, message: "Public Space invite is unavailable" } }, { status: 404 });
  return Response.json({ error: { code: "auth.unauthorized", message: "Sign in required" } }, { status: 401 });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it.each(["space_public_invite.unavailable", "arrival.unavailable"])("keeps the observed %s contract failure out of connection retry UI", async (code) => {
  // Sanitized from first-join-wss/report.md: the real arrival API returns this
  // nested 404 contract error. Both Join and Ask again previously blamed the
  // connection. All product modules below are real; only fetch/browser APIs differ.
  window.history.replaceState({}, "", "/space/design-lab#spaceInviteToken=cspi1.unavailable-fixture");
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
  responseCode = code;
  fetch.mockClear();
  vi.stubGlobal("fetch", fetch);
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
  const name = await screen.findByLabelText("Your name");
  fireEvent.change(name, { target: { value: "Ada" } });
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Join call" })));
  expect(await screen.findByText(code === "space_public_invite.unavailable" ? "This invite link is unavailable. Ask the host for a new link." : "Your request to join is no longer available. Open the invite link and join again.")).toBeDefined();
  expect(screen.queryByRole("button", { name: "Ask again" })).toBeNull();
  expect(screen.queryByText(/Check your connection/)).toBeNull();
  expect(fetch.mock.calls.some(([input]) => String(input instanceof Request ? input.url : input).endsWith("/v1/public/space-invite-arrivals"))).toBe(true);
});
