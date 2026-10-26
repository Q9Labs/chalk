/* @vitest-environment jsdom */
import { Suspense } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { Route } from "../../routes/dashboard_.call.$spaceId.join";

vi.mock("@tanstack/react-router", async (original) => ({ ...(await original<typeof import("@tanstack/react-router")>()), createFileRoute: () => (options: unknown) => ({ options, useParams: () => ({ spaceId: "owner-space" }) }) }));
const theme = vi.hoisted(() => ({ mode: "dark" }));
vi.mock("../../lib/theme-context", () => ({ useTheme: () => ({ preference: theme.mode, setPreference: vi.fn() }) }));
vi.mock("../dashboard/OwnerCall", () => ({ OwnerCall: ({ spaceId }: { spaceId: string }) => <div>Owner call {spaceId}</div> }));
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it.each(["light", "dark"])("shows the owner-call notice inside its %s Chalk theme scope", async (mode) => {
  theme.mode = mode;
  vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-10-23T00:00:00Z"));
  const Component = Route.options.component;
  if (!Component) throw Error("Owner route component missing");
  await Component.preload?.();
  render(
    <Suspense fallback={null}>
      <Component />
    </Suspense>,
  );
  const call = await screen.findByText("Owner call owner-space");
  expect(call.closest("[data-chalk]")).toBeNull();
  const notice = screen.getByText(/We're updating our Privacy Policy on 6 November 2026/);
  expect(notice.closest("[data-chalk]")?.getAttribute("data-chalk-theme")).toBe(mode);
});
