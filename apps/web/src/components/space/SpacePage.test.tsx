/* @vitest-environment jsdom */

import { StrictMode } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getSpacePageTestMocks, resetSpacePageTestMocks, spacePageTestArrival, spacePageTestToken } from "../../__tests__/space-page.test-support";
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
  it.each([undefined, "design-lab"])("shows the advance notice on public and guest name entry (%s)", (slug) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-21T12:00:00Z"));
    try {
      render(<SpacePage slug={slug} />);
      expect(screen.getByRole("complementary", { name: "Privacy Policy update" })).toBeDefined();
      expect(screen.getByRole("link", { name: "See what's changing." }).getAttribute("href")).toBe("/privacy#whats-changing");
    } finally {
      cleanup();
      vi.useRealTimers();
    }
  });
  it("names the call, not its link slug, before the guest enters", async () => {
    const slug = "call-f689563f-f6ba-411f-b917-851ff649a822";
    window.history.replaceState({}, "", `/space/${slug}#spaceInviteToken=${spacePageTestToken}`);
    mocks.publicClient.arriveBySpacePublicInvite.mockReturnValue(new Promise(() => undefined));
    render(<SpacePage slug={slug} />);
    expect(screen.getByText("Join the call")).toBeDefined();
    await act(async () => enterName("Ada"));
    expect(screen.getByRole("status").textContent).toBe("Joining the call…");
    expect(document.body.textContent).not.toContain(slug);
  });
  it("does not blame an invite link for a join conflict", async () => {
    window.history.replaceState({}, "", `/space/design-lab#spaceInviteToken=${spacePageTestToken}`);
    mocks.publicClient.arriveBySpacePublicInvite.mockRejectedValue(Object.assign(new Error("Participant is not active"), { status: 409 }));
    render(<SpacePage slug="design-lab" />);
    await act(async () => enterName("Ada"));
    await waitFor(() => expect(screen.getByText("You could not enter this Space. Try entering again.")).toBeDefined());
    expect(screen.queryByText(/check the invite link/)).toBeNull();
  });

  it("keeps an app-owned live report draft when the call view unmounts after Leave", async () => {
    mocks.reportsAvailable.mockReturnValue(true);
    await enterInvite();
    const open = mocks.holder.chalkProps?.onOpenReportProblem;
    if (typeof open !== "function") throw new Error("Missing app-owned report action");
    await act(async () => open());
    const input = screen.getByLabelText<HTMLTextAreaElement>("What went wrong?");
    fireEvent.change(input, { target: { value: "Keep my live draft after leaving" } });
    vi.useFakeTimers();
    try {
      await act(async () => vi.advanceTimersByTimeAsync(300_001));
      expect(screen.getByRole("button", { name: "Send" }).hasAttribute("disabled")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
    await leaveCall();
    expect(screen.getByRole("heading", { name: "You left Design Lab" })).toBeDefined();
    expect(screen.getByLabelText("What went wrong?")).toBe(input);
    expect(input.value).toBe("Keep my live draft after leaving");
    expect(screen.getByRole("button", { name: "Send" }).hasAttribute("disabled")).toBe(false);
  });

  it.each(["left", "failed", "episode-ended"])("expires terminal report access without erasing the %s form", async (phase) => {
    mocks.reportsAvailable.mockReturnValue(true);
    const view = await enterInvite();
    const snapshot = mocks.client.getSnapshot();
    vi.useFakeTimers();
    try {
      if (phase === "left") await leaveCall();
      else {
        mocks.client.getSnapshot.mockReturnValue({ ...snapshot, connection: Object.assign({}, snapshot.connection, { status: "failed", lastError: { code: phase === "episode-ended" ? "episode.ended" : "connection.media_start_failed", message: "Connection failed" } }) });
        await act(async () => view.rerender(<SpacePage slug="design-lab" />));
      }
      const report = screen.getByRole("button", { name: "Report a problem" });
      await act(async () => fireEvent.click(report));
      const input = screen.getByLabelText("What went wrong?");
      fireEvent.change(input, { target: { value: "My camera froze after joining." } });
      await act(async () => vi.advanceTimersByTimeAsync(299_999));
      expect(screen.getByRole("button", { name: "Send" }).hasAttribute("disabled")).toBe(false);
      await act(async () => vi.advanceTimersByTimeAsync(1));
      expect(screen.queryByRole("button", { name: "Report a problem" })).toBeNull();
      expect(screen.getByRole("button", { name: "Send" }).hasAttribute("disabled")).toBe(true);
      expect(screen.getByText(/Your call access has expired/)).toBeDefined();
      expect(input).toHaveProperty("value", "My camera froze after joining.");
      expect(input.hasAttribute("disabled")).toBe(false);
      fireEvent.change(input, { target: { value: "I can still edit and copy this." } });
      expect(input).toHaveProperty("value", "I can still edit and copy this.");
      await act(async () => fireEvent.click(screen.getByRole("button", { name: "Cancel" })));
      await act(async () => vi.advanceTimersByTimeAsync(200));
      expect(screen.queryByRole("button", { name: "Report a problem" })).toBeNull();
    } finally {
      cleanup();
      mocks.client.getSnapshot.mockReturnValue(snapshot);
      vi.useRealTimers();
    }
  });

  it("requests a fresh admission when rejoining after Leave", async () => {
    await enterInvite();
    await leaveCall();
    await screen.findByRole("heading", { name: "You left Design Lab" });
    await waitFor(() => expect(screen.getByRole("button", { name: "Rejoin" }).hasAttribute("disabled")).toBe(false));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Rejoin" })));
    await waitFor(() => expect(mocks.publicClient.arriveBySpacePublicInvite).toHaveBeenCalledTimes(2));
  });

  it("releases a failed media arrival without an error event", async () => {
    const view = await enterInvite();
    const snapshot = mocks.client.getSnapshot();
    mocks.client.getSnapshot.mockReturnValue({ ...snapshot, connection: Object.assign({}, snapshot.connection, { status: "failed", lastError: { message: "Private transport details", recoverable: true } }) });
    await act(async () => view.rerender(<SpacePage slug="design-lab" />));
    await waitFor(() => expect(mocks.finish).toHaveBeenCalledTimes(1));
    expect(screen.getByText("Something went wrong while joining. Try again.")).toBeDefined();
    expect(screen.queryByText(/Reference:/)).toBeNull();
    expect(screen.queryByText("Private transport details")).toBeNull();
    mocks.client.getSnapshot.mockReturnValue(snapshot);
  });

  // The first case retains the startup-deadline text from not-joined-edge.jpg;
  // the terminal route must replace it with safe guidance and the real code.
  it.each([
    ["connection.sync_hello_timeout", "The call service did not respond in time. Try again.", "Sync did not become live before the startup deadline"],
    ["connection.media_start_failed", "Audio and video could not connect. Try again.", "Private transport details"],
  ])("keeps %s when the host replaces the call screen", async (code, guidance, message) => {
    const view = await enterInvite();
    const snapshot = mocks.client.getSnapshot();
    try {
      mocks.client.getSnapshot.mockReturnValue({ ...snapshot, connection: Object.assign({}, snapshot.connection, { status: "failed", lastError: { code, recoverable: true, message } }) });
      await act(async () => view.rerender(<SpacePage slug="design-lab" />));
      expect(await screen.findByText(code)).toBeDefined();
      expect(screen.getByText(guidance)).toBeDefined();
      expect(screen.queryByText(/client.internal_error/)).toBeNull();
      expect(screen.queryByText(message)).toBeNull();
    } finally {
      mocks.client.getSnapshot.mockReturnValue(snapshot);
    }
  });

  it("keeps safe Sync details when the host replaces the call screen", async () => {
    const view = await enterInvite();
    const snapshot = mocks.client.getSnapshot();
    const sync = { stage: "upgrade", opened: false, closeCode: 1006, closeReason: null, durationMs: 24 };
    try {
      mocks.client.getSnapshot.mockReturnValue({ ...snapshot, connection: Object.assign({}, snapshot.connection, { status: "failed", lastError: { code: "connection.sync_hello_timeout", recoverable: true, message: "Private transport details", sync } }) });
      await act(async () => view.rerender(<SpacePage slug="design-lab" />));
      expect(await screen.findByText("connection.sync_hello_timeout [upgrade; open=0; close=1006; reason=none; 24ms]")).toBeDefined();
      expect(screen.queryByText("Private transport details")).toBeNull();
    } finally {
      mocks.client.getSnapshot.mockReturnValue(snapshot);
    }
  });

  it("does not prepare devices before joining an invite", async () => {
    window.history.replaceState({}, "", `/space/design-lab#spaceInviteToken=${spacePageTestToken}`);
    render(<SpacePage slug="design-lab" />);
    await act(async () => undefined);
    expect(mocks.publicClient.prepareSpaceEntrance).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: /Camera|Microphone/ })).toBeNull();
    expect(mocks.publicClient.arriveBySpacePublicInvite).not.toHaveBeenCalled();
  });

  it.each(["episode.ended", "connection.sync_start_failed"])("preserves the terminal phase for %s", async (code) => {
    const original = mocks.client.getSnapshot();
    mocks.client.getSnapshot.mockReturnValue({ ...original, connection: Object.assign({}, original.connection, { status: "failed", lastError: { code, message: "Connection failed" } }) });
    try {
      window.history.replaceState({}, "", `/space/design-lab#spaceInviteToken=${spacePageTestToken}`);
      render(<SpacePage slug="design-lab" />);
      enterName("Ada");
      await waitFor(() => expect(screen.getByRole("heading", { name: code === "episode.ended" ? "The call ended" : "Couldn’t connect to Design Lab" })).toBeDefined());
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
    mocks.publicClient.leaveSpacePublicInviteArrival.mockResolvedValue(undefined);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Cancel" })));
    expect(screen.queryByText("Chalk could not connect. Check your connection and try entering again.")).toBeNull();
  });

  it("keeps a lost Cancel from accepting admission until the guest joins again", async () => {
    vi.useFakeTimers();
    try {
      window.history.replaceState({}, "", `/space/design-lab#spaceInviteToken=${spacePageTestToken}`);
      mocks.publicClient.arriveBySpacePublicInvite.mockResolvedValue({ state: "pending", arrival_handle: "arrival-pending", retry_after: 1, space: { slug: "design-lab", name: "Design Lab" } });
      mocks.publicClient.leaveSpacePublicInviteArrival.mockRejectedValueOnce(new TypeError("Failed to fetch")).mockResolvedValue(undefined);
      mocks.publicClient.getSpacePublicInviteArrival.mockResolvedValue(spacePageTestArrival);
      render(<SpacePage slug="design-lab" />);
      await act(async () => enterName("Ada"));
      await act(async () => fireEvent.click(screen.getByRole("button", { name: "Cancel" })));
      await act(async () => vi.advanceTimersByTimeAsync(1_000));
      expect(mocks.createPreparedPublicSpace).not.toHaveBeenCalled();
      expect(mocks.holder.chalkProps).toBeUndefined();

      await act(async () => fireEvent.click(screen.getByRole("button", { name: "Cancel" })));
      expect(mocks.publicClient.leaveSpacePublicInviteArrival).toHaveBeenNthCalledWith(1, "arrival-pending");
      expect(mocks.publicClient.leaveSpacePublicInviteArrival).toHaveBeenNthCalledWith(2, "arrival-pending");
      await act(async () => vi.advanceTimersByTimeAsync(1_000));
      expect(mocks.createPreparedPublicSpace).not.toHaveBeenCalled();
      expect(mocks.holder.chalkProps).toBeUndefined();

      mocks.publicClient.arriveBySpacePublicInvite.mockResolvedValue({ state: "pending", arrival_handle: "arrival-next", retry_after: 1, space: { slug: "design-lab", name: "Design Lab" } });
      await act(async () => fireEvent.click(screen.getByRole("button", { name: "Join call" })));
      await act(async () => vi.advanceTimersByTimeAsync(1_000));
      expect(mocks.publicClient.getSpacePublicInviteArrival).toHaveBeenLastCalledWith("arrival-next");
      expect(mocks.holder.chalkProps).toBeDefined();
    } finally {
      cleanup();
      vi.useRealTimers();
    }
  });

  it("keeps best-effort unmount withdrawal while Cancel is in flight", async () => {
    window.history.replaceState({}, "", `/space/design-lab#spaceInviteToken=${spacePageTestToken}`);
    mocks.publicClient.arriveBySpacePublicInvite.mockResolvedValue({ state: "pending", arrival_handle: "arrival-pending", retry_after: 30, space: { slug: "design-lab", name: "Design Lab" } });
    let finishCancel: () => void = () => {
      throw new Error("Cancel has not started");
    };
    mocks.publicClient.leaveSpacePublicInviteArrival
      .mockReturnValueOnce(
        new Promise<undefined>((resolve) => {
          finishCancel = () => resolve(undefined);
        }),
      )
      .mockResolvedValue(undefined);
    const view = render(<SpacePage slug="design-lab" />);
    await act(async () => enterName("Ada"));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Cancel" })));
    view.unmount();
    expect(mocks.publicClient.leaveSpacePublicInviteArrival).toHaveBeenCalledTimes(2);
    await act(async () => finishCancel());
  });

  it("ignores an admission response that arrives while Cancel is in flight", async () => {
    vi.useFakeTimers();
    try {
      window.history.replaceState({}, "", `/space/design-lab#spaceInviteToken=${spacePageTestToken}`);
      mocks.publicClient.arriveBySpacePublicInvite.mockResolvedValue({ state: "pending", arrival_handle: "arrival-pending", retry_after: 1, space: { slug: "design-lab", name: "Design Lab" } });
      let resolveStatus: (arrival: typeof spacePageTestArrival) => void = () => {
        throw new Error("Poll has not started");
      };
      mocks.publicClient.getSpacePublicInviteArrival.mockReturnValue(
        new Promise((resolve) => {
          resolveStatus = resolve;
        }),
      );
      let resolveCancel: () => void = () => {
        throw new Error("Cancel has not started");
      };
      mocks.publicClient.leaveSpacePublicInviteArrival.mockReturnValue(
        new Promise<undefined>((resolve) => {
          resolveCancel = () => resolve(undefined);
        }),
      );
      render(<SpacePage slug="design-lab" />);
      await act(async () => enterName("Ada"));
      await act(async () => vi.advanceTimersByTimeAsync(1_000));
      expect(mocks.publicClient.getSpacePublicInviteArrival).toHaveBeenCalledOnce();
      await act(async () => fireEvent.click(screen.getByRole("button", { name: "Cancel" })));
      await act(async () => resolveStatus(spacePageTestArrival));
      expect(mocks.createPreparedPublicSpace).not.toHaveBeenCalled();
      expect(mocks.holder.chalkProps).toBeUndefined();
      await act(async () => resolveCancel());
      expect(screen.queryByText("Asking to join Design Lab")).toBeNull();
    } finally {
      cleanup();
      vi.useRealTimers();
    }
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

  it("does not replace an edited name when a delayed account lookup resolves", async () => {
    window.history.replaceState({}, "", `/space/design-lab#spaceInviteToken=${spacePageTestToken}`);
    let resolveAccount: ((account: { name: string }) => void) | undefined;
    mocks.getAccount.mockReturnValue(
      new Promise((resolve) => {
        resolveAccount = resolve;
      }),
    );
    render(<SpacePage slug="design-lab" />);
    fireEvent.change(screen.getByLabelText("Your name"), { target: { value: "Bea" } });
    await act(async () => resolveAccount?.({ name: "Ada" }));
    expect(mocks.publicClient.arriveBySpacePublicInvite).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Your name").getAttribute("value")).toBe("Bea");
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Join call" })));
    expect(mocks.publicClient.arriveBySpacePublicInvite).toHaveBeenCalledWith(spacePageTestToken, "Bea");
  });

  it.each(["query", "browser", "account"])("joins directly with a known %s name and both devices off", async (source) => {
    window.history.replaceState({}, "", `/space/design-lab${source === "query" ? "?name=Ada" : ""}#spaceInviteToken=${spacePageTestToken}`);
    if (source === "browser") window.localStorage.setItem("chalk.display-name", "Ada");
    if (source === "account") mocks.getAccount.mockResolvedValue({ name: "Ada" });
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

  it("keeps the same privacy notice mounted through automatic admission until dismissed", async () => {
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-10-21T12:00:00Z"));
    window.history.replaceState({}, "", `/space/design-lab?name=Ada#spaceInviteToken=${spacePageTestToken}`);
    try {
      render(<SpacePage slug="design-lab" />);
      const notice = screen.getByRole("complementary", { name: "Privacy Policy update" });
      await waitFor(() => expect(mocks.holder.chalkProps).toMatchObject({ displayName: "Ada" }));
      expect(screen.getByRole("complementary", { name: "Privacy Policy update" })).toBe(notice);
      const policyLink = screen.getByRole("link", { name: "See what's changing." });
      expect(policyLink.getAttribute("target")).toBe("_blank");
      expect(policyLink.getAttribute("rel")).toBe("noopener noreferrer");
      fireEvent.click(screen.getByRole("button", { name: "Dismiss Privacy Policy notice" }));
      expect(screen.queryByRole("complementary", { name: "Privacy Policy update" })).toBeNull();
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("keeps access on page hide and remembers only enabled devices", async () => {
    const view = await enterInvite();

    window.dispatchEvent(new Event("pagehide"));
    expect(mocks.prepared.finish).not.toHaveBeenCalled();
    expect(JSON.parse(window.sessionStorage.getItem(reloadRejoinStorageKey) ?? "null")).toMatchObject({ microphone: false, camera: true, arrivalHandle: "arrival-11111111" });
    view.unmount();
  });
});

async function enterInvite() {
  window.history.replaceState({}, "", `/space/design-lab#spaceInviteToken=${spacePageTestToken}`);
  const view = render(<SpacePage slug="design-lab" />);
  await act(async () => enterName("Ada"));
  await waitFor(() => expect(mocks.holder.chalkProps).toBeDefined());
  return view;
}

async function leaveCall(): Promise<void> {
  const onLeft = mocks.holder.chalkProps?.onLeft;
  if (typeof onLeft !== "function") throw new Error("Missing Leave callback");
  await act(async () => onLeft());
}

function enterName(displayName: string): void {
  fireEvent.change(screen.getByLabelText("Your name"), { target: { value: displayName } });
  fireEvent.click(screen.getByRole("button", { name: "Join call" }));
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
    expect(screen.getByRole("status").textContent).toBe("Joining the call…");
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
    // The recovered arrival still names the call.
    expect(mocks.holder.chalkProps).toMatchObject({ spaceName: "Design Lab" });
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
    expect(await screen.findByRole("heading", { name: "You left Design Lab" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Rejoin" })).toBeDefined();
    expect(screen.queryByLabelText("Your name")).toBeNull();
    expect(mocks.resumePublicSpace).toHaveBeenCalledOnce();
  });
  it("clears reload intent after Leave", async () => {
    await enterInvite();
    writeReloadRejoin(window.sessionStorage, marker);
    const onLeft = mocks.holder.chalkProps?.onLeft;
    if (typeof onLeft !== "function") throw new Error("Missing Leave callback");
    act(() => onLeft());
    window.dispatchEvent(new Event("pagehide"));
    expect(window.sessionStorage.getItem(reloadRejoinStorageKey)).toBeNull();
  });
});
