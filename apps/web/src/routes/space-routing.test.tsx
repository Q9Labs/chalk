/* @vitest-environment jsdom */

import { RouterProvider } from "@tanstack/react-router";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getSpacePageTestMocks, resetSpacePageTestMocks, spacePageTestToken } from "../__tests__/space-page.test-support";
import { getRouter } from "../router";

const mocks = getSpacePageTestMocks();
let root: Root | undefined;

beforeEach(() => resetSpacePageTestMocks());
afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  await new Promise((resolve) => setTimeout(resolve, 0));
  vi.clearAllMocks();
});

describe("public Space route tree", () => {
  it("renders the index route as a public Space creator", async () => {
    window.history.replaceState({}, "", "/space");
    await renderRouteAndContinue();

    await waitFor(() => expect(mocks.publicClient.createPublicSpace).toHaveBeenCalledWith("Ada"));
    await waitFor(() => expect(mocks.holder.chalkProps).toMatchObject({ inviteLink: window.location.href, spaceName: "Created Space" }));
    expect(window.location.pathname).toBe("/space/created-space");
    expect(screen.queryByLabelText("Your name")).toBeNull();
    expect(mocks.publicClient.createPublicSpace).toHaveBeenCalledTimes(1);
    expect(mocks.publicClient.arriveBySpacePublicInvite).not.toHaveBeenCalled();
    expect(mocks.publicClient.leaveSpacePublicInviteArrival).not.toHaveBeenCalled();
  });

  it("renders the named route as a capability arrival", async () => {
    window.history.replaceState({}, "", `/space/design-lab#spaceInviteToken=${spacePageTestToken}`);
    await renderRouteAndContinue();

    await waitFor(() => expect(mocks.publicClient.arriveBySpacePublicInvite).toHaveBeenCalledWith(spacePageTestToken, "Ada"));
    expect(mocks.publicClient.createPublicSpace).not.toHaveBeenCalled();
  });
});

async function renderRouteAndContinue(): Promise<void> {
  const router = getRouter();
  await router.load();
  await act(async () => {
    root = createRoot(document);
    root.render(
      <StrictMode>
        <RouterProvider router={router} />
      </StrictMode>,
    );
  });

  fireEvent.change(await screen.findByLabelText("Your name"), { target: { value: "Ada" } });
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
}
