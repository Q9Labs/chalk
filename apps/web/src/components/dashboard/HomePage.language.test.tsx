// @vitest-environment jsdom
import { act as testingLibraryAct, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { act, readPage } from "../../lib/dashboard/client";
import { HomePage } from "./HomePage";
import { ToastProvider } from "./kit";

const router = vi.hoisted(() => ({ state: { location: { pathname: "/dashboard" } }, navigate: vi.fn() }));
vi.mock("@tanstack/react-router", async () => {
  const { createElement } = await import("react");
  return { Link: ({ children }: { children?: ReactNode }) => createElement("a", null, children), useNavigate: () => router.navigate, useRouter: () => router };
});
vi.mock("../../lib/dashboard/client", async (original) => {
  const client = await original<typeof import("../../lib/dashboard/client")>();
  return { ...client, act: vi.fn(), readPage: vi.fn() };
});

const created = { id: "00000000-0000-4000-8000-000000000001", name: "New call", slug: "call-new", archived: false, admission: "knock" as const, createdAt: "2026-10-21T00:00:00Z" };

beforeEach(() => {
  window.localStorage.clear();
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  vi.mocked(readPage).mockImplementation(async (name) => {
    if (name === "home") return { calls: [], live: [], nextCursor: null };
    if (name === "call-invite") return { inviteUrl: "https://chalk.example/join/new" };
    throw new Error(`unexpected ${name}`);
  });
  vi.mocked(act).mockResolvedValue({ call: created });
});
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
  vi.unstubAllGlobals();
});

async function open() {
  await testingLibraryAct(async () => {
    render(
      <ToastProvider>
        <HomePage />
      </ToastProvider>,
    );
  });
}

const chip = () => screen.getByRole("button", { name: /Transcript for new calls/ });

it("starts calls on the account default until a language is chosen", async () => {
  await open();
  expect(chip().textContent).toContain("Use account default");
  await testingLibraryAct(async () => {
    fireEvent.click(screen.getAllByRole("button", { name: "Start a call" })[0] as HTMLElement);
  });
  const [, payload] = vi.mocked(act).mock.calls[0] ?? [];
  expect(payload).not.toHaveProperty("transcriptLanguage");
});

it("starts the next call in the chosen language and keeps the choice on this device", async () => {
  await open();
  fireEvent.click(chip());
  fireEvent.change(screen.getByRole("combobox", { name: "Search languages" }), { target: { value: "urdu" } });
  fireEvent.keyDown(screen.getByRole("combobox", { name: "Search languages" }), { key: "Enter" });
  expect(chip().textContent).toContain("Urdu");
  expect(window.localStorage.getItem("chalk.transcript-language.new-call")).toBe("ur");
  await testingLibraryAct(async () => {
    fireEvent.click(screen.getAllByRole("button", { name: "Start a call" })[0] as HTMLElement);
  });
  expect(vi.mocked(act)).toHaveBeenCalledWith("home", expect.objectContaining({ action: "create-call", transcriptLanguage: "ur" }));
});

it("remembers the language for the next visit and can go back to the account default", async () => {
  window.localStorage.setItem("chalk.transcript-language.new-call", "auto");
  await open();
  expect(chip().textContent).toContain("Auto-detect");
  fireEvent.click(chip());
  fireEvent.click(screen.getByRole("option", { name: /Use account default/ }));
  expect(window.localStorage.getItem("chalk.transcript-language.new-call")).toBe("default");
});

it("uses a new idempotency key when the language changes after a failed start", async () => {
  vi.mocked(act).mockRejectedValue(new Error("offline"));
  await open();
  const start = () => testingLibraryAct(async () => fireEvent.click(screen.getAllByRole("button", { name: "Start a call" })[0] as HTMLElement));
  await start();
  fireEvent.click(chip());
  fireEvent.click(screen.getByRole("option", { name: /Auto-detect/ }));
  await start();
  const keys = vi.mocked(act).mock.calls.map(([, payload]) => (payload && "idempotencyKey" in payload ? payload.idempotencyKey : null));
  expect(keys).toHaveLength(2);
  expect(keys[0]).not.toBe(keys[1]);
});
