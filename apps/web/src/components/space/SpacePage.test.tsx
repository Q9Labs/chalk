/* @vitest-environment jsdom */

import { StrictMode } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getSpacePageTestMocks, resetSpacePageTestMocks, spacePageTestToken } from "../../__tests__/space-page.test-support";
import { reloadRejoinStorageKey, writeReloadRejoin } from "@q9labsai/chalk-client";
import { SpacePage } from "./SpacePage";

const mocks = getSpacePageTestMocks();

beforeEach(() => resetSpacePageTestMocks());
afterEach(async () => {
  cleanup();
  await act(async () => new Promise<void>((resolve) => globalThis.setTimeout(resolve, 0)));
  vi.clearAllMocks();
});

describe("public Space entry", () => {
  it.each(["episode.ended", "network.failed"])("preserves the terminal phase for %s", async (code) => {
    const original = mocks.client.getSnapshot();
    mocks.client.getSnapshot.mockReturnValue({ ...original, connection: Object.assign({}, original.connection, { status: "failed", lastError: { code, message: "Connection failed" } }) });
    try {
      window.history.replaceState({}, "", `/space/design-lab#spaceInviteToken=${spacePageTestToken}`);
      render(<SpacePage slug="design-lab" />);
      enterName("Ada");
      await waitFor(() => expect(screen.getByText(code === "episode.ended" ? "episode-ended" : "failed")).toBeDefined());
    } finally {
      cleanup();
      mocks.client.getSnapshot.mockReturnValue(original);
    }
  });

  it("does not prepare Capture for an unauthenticated slug-only Entrance", async () => {
    window.history.replaceState({}, "", "/space/design-lab");
    render(<SpacePage slug="design-lab" />);
    await act(async () => undefined);
    expect(mocks.publicClient.prepareSpaceEntrance).not.toHaveBeenCalled();
  });

  it("admits a guest through a capability link and renders the canonical Space", async () => {
    window.history.replaceState({}, "", `/space/design-lab#spaceInviteToken=${spacePageTestToken}`);
    const navigatePublicSpace = vi.fn(async () => undefined);
    render(<SpacePage slug="design-lab" navigatePublicSpace={navigatePublicSpace} />);
    enterName(" Ada ");

    await waitFor(() => expect(mocks.publicClient.arriveBySpacePublicInvite).toHaveBeenCalledWith(spacePageTestToken, "Ada"));
    await waitFor(() => expect(navigatePublicSpace).toHaveBeenCalledWith("design-lab", `${window.location.origin}/space/design-lab#spaceInviteToken=${spacePageTestToken}`));
    expect(mocks.publicClient.createPublicSpace).not.toHaveBeenCalled();
    await waitFor(() => expect(mocks.holder.chalkProps).toMatchObject({ spaceName: "Design Lab" }));
  });

  it("shows a failed cancellation without hiding the pending request", async () => {
    window.history.replaceState({}, "", `/space/design-lab#spaceInviteToken=${spacePageTestToken}`);
    mocks.publicClient.arriveBySpacePublicInvite.mockResolvedValue({ state: "pending", arrival_handle: "arrival-pending", retry_after: 30, space: { slug: "design-lab", name: "Design Lab" } });
    mocks.publicClient.leaveSpacePublicInviteArrival.mockRejectedValue(new Error("Network unavailable"));
    render(<SpacePage slug="design-lab" />);
    await act(async () => enterName("Ada"));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Cancel" })));
    expect(screen.getByText("Chalk could not connect. Check your connection and try entering again.")).toBeDefined();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDefined();
  });

  it.each(["rejected", "unavailable"])("explains %s admission and can ask again", async (state) => {
    vi.useFakeTimers();
    try {
      window.history.replaceState({}, "", `/space/design-lab#spaceInviteToken=${spacePageTestToken}`);
      mocks.publicClient.arriveBySpacePublicInvite.mockResolvedValue({ state: "pending", arrival_handle: "arrival-pending", retry_after: 1, space: { slug: "design-lab", name: "Design Lab" } });
      mocks.publicClient.getSpacePublicInviteArrival.mockResolvedValue({ state });
      render(<SpacePage slug="design-lab" />);
      await act(async () => enterName("Ada"));
      expect(screen.getByText("Asking to join Design Lab")).toBeDefined();
      await act(async () => vi.advanceTimersByTimeAsync(1_000));
      expect(screen.getByText(state === "rejected" ? "The host declined your request to join." : "Your request to join expired or is no longer available.")).toBeDefined();
      await act(async () => fireEvent.click(screen.getByRole("button", { name: "Ask again" })));
      expect(mocks.publicClient.arriveBySpacePublicInvite).toHaveBeenCalledTimes(2);
      expect(screen.queryByRole("button", { name: /Camera|Microphone/ })).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(["query", "browser"])("joins directly with a known %s name and both devices off", async (source) => {
    window.history.replaceState({}, "", `/space/design-lab${source === "query" ? "?name=Ada" : ""}#spaceInviteToken=${spacePageTestToken}`);
    if (source === "browser") window.localStorage.setItem("chalk.display-name", "Ada");
    render(
      <StrictMode>
        <SpacePage slug="design-lab" />
      </StrictMode>,
    );
    await waitFor(() => expect(mocks.holder.chalkProps).toMatchObject({ displayName: "Ada", defaults: { microphone: false, camera: false } }));
    expect(mocks.publicClient.arriveBySpacePublicInvite).toHaveBeenCalledTimes(1);
    expect(mocks.publicClient.prepareSpaceEntrance).not.toHaveBeenCalled();
    expect(window.localStorage.getItem("chalk.display-name")).toBe("Ada");
    expect(screen.queryByLabelText("Your name")).toBeNull();
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

async function leaveCall(): Promise<void> {
  const onLeft = mocks.holder.chalkProps?.onLeft;
  if (typeof onLeft !== "function") throw new Error("Missing Leave callback");
  await act(async () => onLeft());
}

function enterName(displayName: string): void {
  fireEvent.change(screen.getByLabelText("Your name"), { target: { value: displayName } });
  fireEvent.click(screen.getByRole("button", { name: "Join" }));
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
    expect(screen.getByRole("status").textContent).toBe("Joining design-lab…");
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
  it.each(["ended", "removed"])("shows the recovery failure when %s access is rejected", async (reason) => {
    window.localStorage.setItem("chalk.display-name", "Ada");
    writeReloadRejoin(window.sessionStorage, marker);
    mocks.resumePublicSpace.mockRejectedValue(new Error(reason));
    render(<SpacePage slug="design-lab" />);
    await screen.findByText("Could not return to the Episode. Check your access before joining again.");
    expect(mocks.holder.chalkProps).toBeUndefined();
    expect(mocks.publicClient.arriveBySpacePublicInvite).not.toHaveBeenCalled();
    expect(window.sessionStorage.getItem(reloadRejoinStorageKey)).toBeNull();
  });
  it("shows the status page after leaving a recovered call with a remembered name", async () => {
    window.localStorage.setItem("chalk.display-name", "Ada");
    writeReloadRejoin(window.sessionStorage, marker);
    render(<SpacePage slug="design-lab" />);
    await waitFor(() => expect(mocks.holder.chalkProps).toBeDefined());
    await leaveCall();
    expect(await screen.findByRole("heading", { name: "You left design-lab" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Rejoin" })).toBeDefined();
    expect(screen.queryByLabelText("Your name")).toBeNull();
    expect(mocks.resumePublicSpace).toHaveBeenCalledOnce();
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
