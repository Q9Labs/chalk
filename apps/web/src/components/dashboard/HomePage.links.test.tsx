// @vitest-environment jsdom
import { act as reactAct, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { HomePage } from "./HomePage";

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
    fireEvent.click(screen.getByRole("button", { name: "Copy link", exact: true }));
  });
  expect(writeText).toHaveBeenCalledWith("https://chalk.test/join/invite");
});
