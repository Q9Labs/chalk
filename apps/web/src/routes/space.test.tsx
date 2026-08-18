/* @vitest-environment jsdom */

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { cleanupSpacePageTestMocks, getSpacePageTestMocks, resetSpacePageTestMocks, spacePageTestCredential } from "../__tests__/space-page.test-support";

import { SpacePage } from "../components/space/SpacePage";

const mocks = getSpacePageTestMocks();

beforeEach(resetSpacePageTestMocks);

afterEach(async () => {
  cleanup();
  await cleanupSpacePageTestMocks();
});

describe("public SDK Space route", () => {
  it("creates the app-owned client from the validated broker credential and one page journey", async () => {
    await enterSpace();

    expect(mocks.createParticipantCredential).toHaveBeenCalledWith("Ada", undefined, mocks.journey);
    expect(mocks.telemetry.configureApiBaseURL).toHaveBeenCalledWith(spacePageTestCredential.apiBaseURL);
    expect(mocks.createLocalSpaceClient).toHaveBeenCalledOnce();
    expect(mocks.createLocalSpaceClient).toHaveBeenCalledWith({ credential: spacePageTestCredential, getAccess: mocks.getAccess, connectionAccess: mocks.brokerConnectionAccess, journey: mocks.journey });
    expect(mocks.Chalk).toHaveBeenCalledWith(expect.objectContaining({ client: mocks.client, entrance: true, displayName: "Ada" }), undefined);
  });

  it("clears the invite fragment only after cleanup succeeds", async () => {
    const { cleanupPromise, resolveCleanup } = deferredCleanup();
    await enterInvitedSpace();

    invokeLifecycleCallbacks("onLeft");
    expect(mocks.cleanupParticipantCredential).toHaveBeenCalledOnce();
    expect(window.location.hash).toBe(`#spaceInviteToken=${spacePageTestCredential.spaceInviteToken}`);

    await finishDeferredCleanup(cleanupPromise, resolveCleanup);
  });

  it("routes concurrent leave and Episode completion through one release", async () => {
    const { cleanupPromise, resolveCleanup } = deferredCleanup();
    await enterInvitedSpace();

    expect(mocks.holder.chalkProps?.onEpisodeEnded).toEqual(expect.any(Function));
    invokeLifecycleCallbacks("onLeft", "onEpisodeEnded");

    const release = mocks.createLocalSpaceRelease.mock.results[0]?.value as ReturnType<typeof vi.fn>;
    expect(release).toHaveBeenCalledTimes(2);
    expect(mocks.cleanupParticipantCredential).toHaveBeenCalledOnce();
    expect(window.location.hash).toBe(`#spaceInviteToken=${spacePageTestCredential.spaceInviteToken}`);

    await finishDeferredCleanup(cleanupPromise, resolveCleanup);
    expect(mocks.cleanupParticipantCredential).toHaveBeenCalledOnce();
  });

  it("keeps the fragment and retries a transient cleanup failure", async () => {
    setInviteTokenInLocation();
    const transient = Object.assign(new Error("broker unavailable"), { status: 503 });
    mocks.cleanupParticipantCredential.mockRejectedValueOnce(transient).mockResolvedValueOnce(undefined);
    await enterSpace();

    invokeLifecycleCallbacks("onLeft");
    const firstRelease = mocks.createLocalSpaceRelease.mock.results[0]?.value as ReturnType<typeof vi.fn>;
    await waitFor(() => expect(firstRelease).toHaveBeenCalledOnce());
    expect(window.location.hash).toBe(`#spaceInviteToken=${spacePageTestCredential.spaceInviteToken}`);

    invokeLifecycleCallbacks("onLeft");
    await waitFor(() => expect(mocks.cleanupParticipantCredential).toHaveBeenCalledTimes(2));
    expect(window.location.hash).toBe("");
  });

  it("uses unload-safe cleanup when the page closes", async () => {
    await enterInvitedSpace();

    act(() => window.dispatchEvent(pageHideEvent(false)));

    await waitFor(() => expect(mocks.cleanupParticipantCredential).toHaveBeenCalledWith(mocks.journey, { keepalive: true }));
    expect(window.location.hash).toBe("");
  });

  it("keeps the credential when the page enters the back-forward cache", async () => {
    await enterInvitedSpace();

    act(() => window.dispatchEvent(pageHideEvent(true)));

    expect(mocks.cleanupParticipantCredential).not.toHaveBeenCalled();
    expect(window.location.hash).toBe(`#spaceInviteToken=${spacePageTestCredential.spaceInviteToken}`);
  });
});

async function enterSpace(): Promise<void> {
  render(<SpacePage />);
  fireEvent.change(screen.getByLabelText("Your name"), { target: { value: "Ada" } });
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
  await waitFor(() => expect(mocks.holder.chalkProps).toBeDefined());
}

async function enterInvitedSpace(): Promise<void> {
  setInviteTokenInLocation();
  await enterSpace();
}

function setInviteTokenInLocation(): void {
  window.history.replaceState({}, "", `/space#spaceInviteToken=${spacePageTestCredential.spaceInviteToken}`);
}

function deferredCleanup(): { readonly cleanupPromise: Promise<void>; readonly resolveCleanup: () => void } {
  let resolveCleanup!: () => void;
  const cleanupPromise = new Promise<void>((resolve) => {
    resolveCleanup = resolve;
  });
  mocks.cleanupParticipantCredential.mockReturnValueOnce(cleanupPromise);
  return { cleanupPromise, resolveCleanup };
}

function invokeLifecycleCallbacks(...names: Array<"onLeft" | "onEpisodeEnded">): void {
  act(() => {
    for (const name of names) (mocks.holder.chalkProps?.[name] as () => void)();
  });
}

async function finishDeferredCleanup(cleanupPromise: Promise<void>, resolveCleanup: () => void): Promise<void> {
  await act(async () => {
    resolveCleanup();
    await cleanupPromise;
  });
  expect(window.location.hash).toBe("");
}

function pageHideEvent(persisted: boolean): Event {
  const event = new Event("pagehide");
  Object.defineProperty(event, "persisted", { value: persisted });
  return event;
}
