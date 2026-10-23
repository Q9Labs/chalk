// @vitest-environment jsdom
import { act as reactAct, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { HomePage, RenameDialog } from "./HomePage";
import { homeAction, spaceNameMaxCodePoints } from "../../lib/dashboard/contracts";

const router = vi.hoisted(() => ({ state: { location: { pathname: "/dashboard" } }, navigate: vi.fn() }));
vi.mock("@tanstack/react-router", async () => {
  const { createElement } = await import("react");
  return { Link: ({ children }: { children: ReactNode }) => createElement("a", null, children), useNavigate: () => router.navigate, useRouter: () => router };
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("keeps the full code-point name and its suffix when renaming", () => {
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  render(<RenameDialog call={{ id: "space", name: "Call", slug: "call", admission: "knock", archived: false, createdAt: "2026-10-21T00:00:00Z" }} page="home" onClose={() => {}} onRenamed={() => {}} />);
  const name = "🎥".repeat(spaceNameMaxCodePoints - 1) + "🏁";
  const input = screen.getByLabelText("Name");
  fireEvent.change(input, { target: { value: name } });
  expect(input).toHaveProperty("value", name);
  fireEvent.change(input, { target: { value: "extra" + name } });
  expect(input).toHaveProperty("value", name);
  fireEvent.change(input, { target: { value: name + "extra" } });
  expect(input).toHaveProperty("value", name);
  const action = { action: "rename-call", spaceId: "00000000-0000-4000-8000-000000000001", name };
  expect(homeAction.parse(action)).toMatchObject({ name });
  expect(homeAction.safeParse({ ...action, name: name + "🏁" }).success).toBe(false);
});

it("lets a legacy over-limit name shrink one code point at a time, but not grow", () => {
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  const legacyName = "🎥".repeat(130);
  render(<RenameDialog call={{ id: "space", name: legacyName, slug: "call", admission: "knock", archived: false, createdAt: "2026-10-21T00:00:00Z" }} page="home" onClose={() => {}} onRenamed={() => {}} />);
  const input = screen.getByLabelText("Name");
  for (let length = 129; length >= spaceNameMaxCodePoints; length--) {
    const shorter = "🎥".repeat(length);
    fireEvent.change(input, { target: { value: shorter } });
    expect(input).toHaveProperty("value", shorter);
    fireEvent.change(input, { target: { value: shorter + "🏁" } });
    expect(input).toHaveProperty("value", shorter);
  }
  const replacement = "🏁".repeat(spaceNameMaxCodePoints);
  fireEvent.change(input, { target: { value: replacement } });
  expect(input).toHaveProperty("value", replacement);
});

it("copies a Home invite when unrelated Call history is unavailable", async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  vi.stubGlobal("navigator", { clipboard: { writeText } });
  vi.stubGlobal("fetch", async (input: string) => {
    const path = new URL(input, "https://chalk.test").pathname;
    if (path === "/dashboard-api/home") return Response.json({ calls: [{ id: "space", name: "Call", slug: "call", admission: "knock", archived: false, createdAt: "2026-10-21T00:00:00Z", inviteUrl: null, lastActiveAt: null, recentPeople: [] }], live: [], nextCursor: null });
    if (path === "/dashboard-api/call-invite") return Response.json({ inviteUrl: "https://chalk.test/join/invite" });
    return Response.json({ error: { code: "engine_unavailable" } }, { status: 503 });
  });
  await reactAct(async () => {
    render(<HomePage />);
  });
  await reactAct(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Copy link" }));
  });
  expect(writeText).toHaveBeenCalledWith("https://chalk.test/join/invite");
});
