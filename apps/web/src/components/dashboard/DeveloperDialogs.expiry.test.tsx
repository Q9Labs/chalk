// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { CreateKeyDialog } from "./DeveloperDialogs";
import { ToastProvider } from "./kit";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it.each([
  { label: "30 days", days: 30, now: "2026-10-25T14:07:00Z" },
  { label: "90 days", days: 90, now: "2026-10-25T14:07:00Z" },
  { label: "1 year", days: 365, now: "2026-10-25T14:07:00Z" },
  { label: "1 year", days: 365, now: "2028-02-29T00:30:00Z" },
])("submits $label within the API lifetime cap from $now", async ({ label, days, now }) => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(now));
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  const fetch = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => (input === "/auth/session" ? Response.json({ csrfToken: "fixture-csrf", profile: { name: "Fixture" } }) : Response.json({ id: "00000000-0000-4000-8000-000000000001", secret: "fixture-key" })));
  vi.stubGlobal("fetch", fetch);
  const onCreated = vi.fn();
  render(
    <ToastProvider>
      <CreateKeyDialog onClose={() => undefined} onCreated={onCreated} />
    </ToastProvider>,
  );
  fireEvent.change(screen.getByRole("textbox", { name: "Name" }), { target: { value: "Test" } });
  fireEvent.click(screen.getByRole("button", { name: label, exact: true }));
  fireEvent.click(screen.getByRole("button", { name: "Create key", exact: true }));
  await waitFor(() => expect(onCreated).toHaveBeenCalledWith("fixture-key"));
  const options = fetch.mock.calls.find(([input]) => input === "/dashboard-api/developer")?.[1];
  expect(JSON.parse(String(options?.body))).toMatchObject({
    action: "create-key",
    expiresAt: new Date(Date.parse(now) + days * 24 * 60 * 60 * 1000).toISOString(),
  });
});

it("retries the same key request after a network failure without creating another intent", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-25T14:07:00Z"));
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  const requests: string[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    if (input === "/auth/session") return Response.json({ csrfToken: "fixture-csrf", profile: { name: "Fixture" } });
    requests.push(String(init?.body));
    if (requests.length === 1) throw new TypeError("fixture connection lost");
    return Response.json({ id: "00000000-0000-4000-8000-000000000001", secret: "fixture-key" });
  });
  const onCreated = vi.fn();
  render(
    <ToastProvider>
      <CreateKeyDialog onClose={() => undefined} onCreated={onCreated} />
    </ToastProvider>,
  );
  fireEvent.change(screen.getByRole("textbox", { name: "Name" }), { target: { value: "Test" } });
  fireEvent.click(screen.getByRole("button", { name: "1 year", exact: true }));
  fireEvent.click(screen.getByRole("button", { name: "Create key", exact: true }));
  await screen.findByText("Check your connection, then try again.");
  vi.setSystemTime(new Date("2026-10-25T14:08:00Z"));
  fireEvent.click(screen.getByRole("button", { name: "Create key", exact: true }));
  await waitFor(() => expect(onCreated).toHaveBeenCalledWith("fixture-key"));
  expect(requests).toHaveLength(2);
  expect(requests[1]).toBe(requests[0]);
});
