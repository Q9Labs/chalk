/* @vitest-environment jsdom */
import { Suspense } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { Route } from "../../routes/dashboard_.call.$spaceId.join";

vi.mock("@tanstack/react-router", async (original) => ({ ...(await original<typeof import("@tanstack/react-router")>()), createFileRoute: () => (options: unknown) => ({ options, useParams: () => ({ spaceId: "owner-space" }) }) }));
vi.mock("../dashboard/OwnerCall", () => ({ OwnerCall: ({ spaceId }: { spaceId: string }) => <div>Owner call {spaceId}</div> }));
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it("shows the update notice on a direct owner-call route outside AppShell", async () => {
  vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-10-23T00:00:00Z"));
  const Component = Route.options.component;
  if (!Component) throw Error("Owner route component missing");
  await Component.preload?.();
  render(
    <Suspense fallback={null}>
      <Component />
    </Suspense>,
  );
  expect(await screen.findByText("Owner call owner-space")).toBeTruthy();
  expect(screen.getByText(/We're updating our Privacy Policy on 6 November 2026/)).toBeTruthy();
});
