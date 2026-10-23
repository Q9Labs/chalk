// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DeveloperPage } from "./DeveloperPage";

let mode = "on_demand";
let fail = false;
const writes: unknown[] = [];
beforeEach(() => {
  mode = "on_demand";
  fail = false;
  writes.length = 0;
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  vi.stubGlobal("fetch", async (input: string, init?: RequestInit) => {
    if (input === "/auth/session") return Response.json({ csrfToken: "fixture-csrf", profile: { name: "Fixture" } });
    if (init?.method === "POST") {
      const body: unknown = JSON.parse(String(init.body));
      writes.push(body);
      if (fail) return Response.json({ error: { code: "service_unavailable" } }, { status: 503 });
      if (typeof body === "object" && body !== null && "mode" in body && typeof body.mode === "string") mode = body.mode;
      return Response.json({ recordingRenderMode: mode });
    }
    return Response.json({ recordingRenderMode: mode, allowedWebsites: [], keys: [], webhooks: [], nextKeyCursor: null, nextWebhookCursor: null });
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("saves the render setting and reads it after remounting", async () => {
  const page = render(<DeveloperPage />);
  const select = await screen.findByRole("combobox", { name: "Make recording videos" });
  expect(select).toHaveProperty("value", "on_demand");
  const save = screen.getByRole("button", { name: "Save recording settings" });
  expect(save).toHaveProperty("disabled", true);
  fireEvent.change(select, { target: { value: "automatic" } });
  fireEvent.click(save);
  await waitFor(() => expect(writes).toEqual([{ action: "set-recording-render-mode", mode: "automatic" }]));
  await waitFor(() => expect(save).toHaveProperty("disabled", true));
  page.unmount();
  render(<DeveloperPage />);
  expect(await screen.findByRole("combobox", { name: "Make recording videos" })).toHaveProperty("value", "automatic");
});

it("keeps an unsaved selection available after a failed save", async () => {
  fail = true;
  render(<DeveloperPage />);
  const select = await screen.findByRole("combobox", { name: "Make recording videos" });
  fireEvent.change(select, { target: { value: "automatic" } });
  fireEvent.click(screen.getByRole("button", { name: "Save recording settings" }));
  expect(await screen.findByRole("alert")).toBeTruthy();
  expect(select).toHaveProperty("value", "automatic");
  expect(mode).toBe("on_demand");
  expect(screen.getByRole("button", { name: "Save recording settings" })).toHaveProperty("disabled", false);
});
