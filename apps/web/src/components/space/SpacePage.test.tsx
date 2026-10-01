/* @vitest-environment jsdom */

import { StrictMode } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getSpacePageTestMocks, resetSpacePageTestMocks, spacePageTestToken } from "../../__tests__/space-page.test-support";
import { reloadRejoinStorageKey, writeReloadRejoin } from "@q9labsai/chalk-client";
import { SpacePage } from "./SpacePage";

const mocks = getSpacePageTestMocks();

beforeEach(() => resetSpacePageTestMocks());
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("public Space entry", () => {
  it("prepares Capture on opening an invited Entrance before Join", async () => {
    window.history.replaceState({}, "", `/space/design-lab#spaceInviteToken=${spacePageTestToken}`);
    render(<SpacePage slug="design-lab" />);
    await waitFor(() => expect(mocks.publicClient.prepareSpaceEntrance).toHaveBeenCalledWith(spacePageTestToken));
    expect(mocks.publicClient.arriveBySpacePublicInvite).not.toHaveBeenCalled();
    expect(mocks.joinDashboardSpace).not.toHaveBeenCalled();
  });

  it("does not prepare Capture for an unauthenticated slug-only Entrance", async () => {
    window.history.replaceState({}, "", "/space/design-lab");
    render(<SpacePage slug="design-lab" />);
    await act(async () => undefined);
    expect(mocks.publicClient.prepareSpaceEntrance).not.toHaveBeenCalled();
    expect(mocks.prepareDashboardEntrance).not.toHaveBeenCalled();
  });
  it("keeps devices off for a dashboard no-device entry until a participant changes them", async () => {
    window.history.replaceState({}, "", "/space/design-lab?entry=dashboard&devices=off");
    const getUserMedia = vi.fn();
    const originalMediaDevices = Object.getOwnPropertyDescriptor(navigator, "mediaDevices");
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia } });
    mocks.joinDashboardSpace.mockResolvedValue({ credential: mocks.prepared.credential, getAccess: mocks.prepared.getAccess, leave: mocks.finish });
    try {
      render(<SpacePage slug="design-lab" />);
      expect(mocks.holder.entranceProps).toMatchObject({ defaults: { microphone: false, camera: false } });
      expect(getUserMedia).not.toHaveBeenCalled();

      await act(async () => enterName("Ada"));
      await waitFor(() => expect(mocks.holder.chalkProps).toMatchObject({ defaults: { microphone: false, camera: false } }));
    } finally {
      if (originalMediaDevices) Object.defineProperty(navigator, "mediaDevices", originalMediaDevices);
      else Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: undefined });
    }
  });

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

  it("keeps access on page hide and remembers only enabled devices", async () => {
    window.history.replaceState({}, "", `/space/design-lab#spaceInviteToken=${spacePageTestToken}`);
    const view = render(<SpacePage slug="design-lab" />);
    await act(async () => enterName("Ada"));
    await waitFor(() => expect(mocks.holder.chalkProps).toBeDefined());

    window.dispatchEvent(new Event("pagehide"));
    expect(mocks.prepared.finish).not.toHaveBeenCalled();
    expect(JSON.parse(window.sessionStorage.getItem(reloadRejoinStorageKey) ?? "null")).toMatchObject({ microphone: false, camera: true, arrivalHandle: "arrival-11111111" });
    view.unmount();
  });
});

function enterName(displayName: string): void {
  fireEvent.change(screen.getByLabelText("Your name"), { target: { value: displayName } });
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
}

describe("reload rejoin", () => {
  const marker = { space: "design-lab", episodeId: "33333333-3333-4333-8333-333333333333", participantId: "participant-1", participantGeneration: 1, arrivalHandle: "arrival-11111111", mediaProof: "proof", displayName: "Ada", microphone: false, camera: false };
  it("does not mount device preview before recovery, including StrictMode", async () => {
    writeReloadRejoin(window.sessionStorage, marker);
    let completeRecovery: ((value: typeof mocks.prepared) => void) | undefined;
    mocks.resumePublicSpace.mockReturnValue(
      new Promise((resolve) => {
        completeRecovery = resolve;
      }),
    );
    render(
      <StrictMode>
        <SpacePage slug="design-lab" />
      </StrictMode>,
    );
    expect(screen.getByRole("status").textContent).toBe("Returning to the Episode…");
    expect(mocks.holder.entranceProps).toBeUndefined();
    await act(async () => completeRecovery?.(mocks.prepared));
    await waitFor(() => expect(mocks.holder.chalkProps?.defaults).toEqual({ microphone: false, camera: false }));
    expect(mocks.resumePublicSpace).toHaveBeenCalledOnce();
  });
  it("returns without Join and keeps both devices off", async () => {
    window.history.replaceState({}, "", "/space/design-lab");
    writeReloadRejoin(window.sessionStorage, marker);
    render(<SpacePage slug="design-lab" />);
    await waitFor(() => expect(mocks.holder.chalkProps).toBeDefined());
    expect(mocks.resumePublicSpace).toHaveBeenCalledOnce();
    expect(mocks.holder.chalkProps?.defaults).toEqual({ microphone: false, camera: false });
    expect(mocks.publicClient.arriveBySpacePublicInvite).not.toHaveBeenCalled();
    expect(window.sessionStorage.getItem(reloadRejoinStorageKey)).toBeNull();
  });
  it.each(["ended", "removed"])("stays at Entrance when %s access is rejected", async (reason) => {
    writeReloadRejoin(window.sessionStorage, marker);
    mocks.resumePublicSpace.mockRejectedValue(new Error(reason));
    render(<SpacePage slug="design-lab" />);
    await screen.findByRole("alert");
    expect(mocks.holder.chalkProps).toBeUndefined();
    expect(mocks.publicClient.arriveBySpacePublicInvite).not.toHaveBeenCalled();
    expect(window.sessionStorage.getItem(reloadRejoinStorageKey)).toBeNull();
  });
  it("clears reload intent after Leave", async () => {
    window.history.replaceState({}, "", `/space/design-lab#spaceInviteToken=${spacePageTestToken}`);
    render(<SpacePage slug="design-lab" />);
    await act(async () => enterName("Ada"));
    await waitFor(() => expect(mocks.holder.chalkProps).toBeDefined());
    writeReloadRejoin(window.sessionStorage, marker);
    const onLeft = mocks.holder.chalkProps?.onLeft;
    if (typeof onLeft !== "function") throw new Error("Missing Leave callback");
    act(() => onLeft());
    window.dispatchEvent(new Event("pagehide"));
    expect(window.sessionStorage.getItem(reloadRejoinStorageKey)).toBeNull();
  });
});
