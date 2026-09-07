/* @vitest-environment jsdom */

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getSpacePageTestMocks, resetSpacePageTestMocks, spacePageTestToken } from "../../__tests__/space-page.test-support";
import { SpacePage } from "./SpacePage";

const mocks = getSpacePageTestMocks();

beforeEach(() => resetSpacePageTestMocks());
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("public Space entry", () => {
  it("ignores a stored Tenant hint the current account cannot access", async () => {
    window.history.replaceState({}, "", "/space/design-lab?entry=dashboard");
    const storage = { getItem: vi.fn(() => "old-account-tenant"), setItem: vi.fn() };
    vi.stubGlobal("localStorage", storage);
    mocks.joinDashboardSpace.mockResolvedValue({ credential: mocks.prepared.credential, getAccess: mocks.prepared.getAccess, leave: mocks.finish });
    try {
      render(<SpacePage slug="design-lab" />);
      await act(async () => enterName("Ada"));
      expect(mocks.joinDashboardSpace).toHaveBeenCalledWith("tenant-1", "design-lab", "Ada", mocks.journey);
      expect(storage.setItem).toHaveBeenCalledWith("chalk.tenant-hint", "tenant-1");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("admits a guest through a capability link and renders the canonical Space", async () => {
    window.history.replaceState({}, "", `/space/design-lab#spaceInviteToken=${spacePageTestToken}`);
    const navigatePublicSpace = vi.fn(async () => undefined);
    render(<SpacePage slug="design-lab" navigatePublicSpace={navigatePublicSpace} />);
    enterName(" Ada ");

    await waitFor(() => expect(mocks.publicClient.arriveBySpacePublicInvite).toHaveBeenCalledWith(spacePageTestToken, "Ada"));
    await waitFor(() => expect(navigatePublicSpace).toHaveBeenCalledWith("design-lab", `${window.location.origin}/space/design-lab#spaceInviteToken=${spacePageTestToken}`));
    expect(mocks.publicClient.createPublicSpace).not.toHaveBeenCalled();
    await waitFor(() => expect(mocks.holder.chalkProps).toMatchObject({ inviteLink: window.location.href, spaceName: "Design Lab" }));
  });

  it("preserves disabled media after pending admission fails", async () => {
    vi.useFakeTimers();
    try {
      window.history.replaceState({}, "", `/space/design-lab#spaceInviteToken=${spacePageTestToken}`);
      mocks.publicClient.arriveBySpacePublicInvite.mockResolvedValue({ state: "pending", arrival_handle: "arrival-pending", retry_after: 1, space: { slug: "design-lab", name: "Design Lab" } });
      mocks.publicClient.getSpacePublicInviteArrival.mockRejectedValue(new Error("Admission failed"));
      render(<SpacePage slug="design-lab" />);
      fireEvent.click(screen.getByRole("button", { name: "Microphone On" }));
      fireEvent.click(screen.getByRole("button", { name: "Camera On" }));
      await act(async () => enterName("Ada"));
      expect(screen.queryByRole("button", { name: "Camera Off" })).toBeNull();
      await act(async () => vi.advanceTimersByTimeAsync(1_000));
      expect(screen.getByRole("button", { name: "Microphone Off" })).toBeDefined();
      expect(screen.getByRole("button", { name: "Camera Off" })).toBeDefined();
      expect(screen.getByLabelText("Your name").getAttribute("value")).toBe("Ada");
    } finally {
      vi.useRealTimers();
    }
  });

  it("finishes prepared access on page hide", async () => {
    window.history.replaceState({}, "", `/space/design-lab#spaceInviteToken=${spacePageTestToken}`);
    const view = render(<SpacePage slug="design-lab" />);
    await act(async () => enterName("Ada"));
    await waitFor(() => expect(mocks.holder.chalkProps).toBeDefined());

    window.dispatchEvent(new Event("pagehide"));
    await waitFor(() => expect(mocks.prepared.finish).toHaveBeenCalledWith({ keepalive: true }));
    view.unmount();
  });
});

function enterName(displayName: string): void {
  fireEvent.change(screen.getByLabelText("Your name"), { target: { value: displayName } });
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
}
