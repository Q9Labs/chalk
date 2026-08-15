/* @vitest-environment jsdom */

import { RouterProvider } from "@tanstack/react-router";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getSpacePageTestMocks, resetSpacePageTestMocks, spacePageTestCredential } from "../__tests__/space-page.test-support";
import { getRouter } from "../router";

const mocks = getSpacePageTestMocks();
let root: Root | undefined;

beforeEach(() => {
  resetSpacePageTestMocks();
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  await new Promise((resolve) => setTimeout(resolve, 0));
  vi.clearAllMocks();
});

describe("Space route tree", () => {
  it("renders the named Dashboard Space route instead of the public broker route", async () => {
    window.history.replaceState({}, "", `/space/design-lab?entry=dashboard#spaceInviteToken=${spacePageTestCredential.spaceInviteToken}`);

    await renderRouteAndContinue();

    await waitFor(() => expect(mocks.joinDashboardSpace).toHaveBeenCalledWith("tenant-1", "design-lab", "Ada", mocks.journey));
    expect(mocks.createParticipantCredential).not.toHaveBeenCalled();
    expect(window.location.search).toBe("");
    expect(window.location.hash).toBe("");
  });

  it("keeps the public broker Space at the index route", async () => {
    window.history.replaceState({}, "", `/space#spaceInviteToken=${spacePageTestCredential.spaceInviteToken}`);

    await renderRouteAndContinue();

    await waitFor(() => expect(mocks.createParticipantCredential).toHaveBeenCalledWith("Ada", spacePageTestCredential.spaceInviteToken, mocks.journey));
    expect(mocks.joinDashboardSpace).not.toHaveBeenCalled();
  });
});

async function renderRouteAndContinue(): Promise<void> {
  const router = getRouter();
  await router.load();
  await act(async () => {
    root = createRoot(document);
    root.render(<RouterProvider router={router} />);
  });

  fireEvent.change(await screen.findByLabelText("Your name"), { target: { value: "Ada" } });
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
}
