/* @vitest-environment jsdom */

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getSpacePageTestMocks, resetSpacePageTestMocks, spacePageTestArrival, spacePageTestToken } from "../../__tests__/space-page.test-support";
import { SpacePage } from "./SpacePage";

const mocks = getSpacePageTestMocks();

beforeEach(() => resetSpacePageTestMocks());
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("public Space entry", () => {
  it("creates a public Space and replaces the index URL with its canonical invite", async () => {
    const index = render(<SpacePage />);
    enterName(" Ada ");

    await waitFor(() => expect(mocks.publicClient.createPublicSpace).toHaveBeenCalledWith("Ada"));
    expect(mocks.publicClient.createPublicSpace).toHaveBeenCalledTimes(1);
    expect(mocks.publicClient.arriveBySpacePublicInvite).not.toHaveBeenCalled();
    expect(mocks.publicClient.leaveSpacePublicInviteArrival).not.toHaveBeenCalled();
    expect(window.location.pathname).toBe("/space/created-space");
    expect(window.location.hash).toBe(`#spaceInviteToken=${spacePageTestToken}`);
    expect(mocks.createPreparedPublicSpace).toHaveBeenCalledWith(mocks.publicClient, spacePageTestArrival, { reenter: expect.any(Function) });
    await waitFor(() => expect(mocks.holder.chalkProps).toMatchObject({ inviteLink: window.location.href, spaceName: "Created Space" }));
    index.unmount();
    await waitFor(() => expect(mocks.prepared.finish).toHaveBeenCalledOnce());
  });

  it("leaves an admitted arrival when the Space page really unmounts", async () => {
    window.history.replaceState({}, "", `/space/design-lab#spaceInviteToken=${spacePageTestToken}`);
    const view = render(<SpacePage slug="design-lab" />);
    enterName("Ada");
    await waitFor(() => expect(mocks.holder.chalkProps).toBeDefined());

    view.unmount();
    await waitFor(() => expect(mocks.prepared.finish).toHaveBeenCalledOnce());
  });

  it("arrives through a capability link without account-management fallback", async () => {
    window.history.replaceState({}, "", `/space/design-lab#spaceInviteToken=${spacePageTestToken}`);
    render(<SpacePage slug="design-lab" />);
    enterName("Ada");

    await waitFor(() => expect(mocks.publicClient.arriveBySpacePublicInvite).toHaveBeenCalledWith(spacePageTestToken, "Ada"));
    expect(mocks.publicClient.createPublicSpace).not.toHaveBeenCalled();
    await waitFor(() => expect(mocks.holder.chalkProps).toMatchObject({ spaceName: "Design Lab", inviteLink: window.location.href }));
  });

  it("mints a fresh public arrival when the supplied client explicitly re-enters", async () => {
    window.history.replaceState({}, "", `/space/design-lab#spaceInviteToken=${spacePageTestToken}`);
    render(<SpacePage slug="design-lab" />);
    enterName("Ada");
    await waitFor(() => expect(mocks.createPreparedPublicSpace).toHaveBeenCalled());
    const reenter = mocks.createPreparedPublicSpace.mock.calls.at(-1)?.[2]?.reenter;
    if (typeof reenter !== "function") throw new Error("The prepared public Space did not receive a re-entry owner.");
    const reenteredArrival = { ...spacePageTestArrival, arrival_handle: "arrival-22222222" };
    mocks.publicClient.arriveBySpacePublicInvite.mockResolvedValueOnce(reenteredArrival);

    await expect(reenter()).resolves.toBe(reenteredArrival);

    expect(mocks.publicClient.arriveBySpacePublicInvite).toHaveBeenLastCalledWith(spacePageTestToken, "Ada");
  });

  it("keeps the explicit account marker on the authenticated join path when no capability is present", async () => {
    window.history.replaceState({}, "", "/space/design-lab?entry=dashboard");
    render(<SpacePage slug="design-lab" />);
    enterName("Ada");

    await waitFor(() => expect(mocks.joinDashboardSpace).toHaveBeenCalledWith("tenant-1", "design-lab", "Ada", mocks.journey));
    expect(mocks.listSpaces).toHaveBeenCalledWith({ tenantID: "tenant-1", cursor: undefined, pageSize: 100 });
    expect(mocks.holder.chalkProps).toMatchObject({ spaceDescription: "A calm design review Space." });
    expect(mocks.publicClient.arriveBySpacePublicInvite).not.toHaveBeenCalled();
    expect(mocks.publicClient.createPublicSpace).not.toHaveBeenCalled();
    expect(window.location.search).toBe("");
  });

  it("passes the server-issued account Space invite to Chalk", async () => {
    window.history.replaceState({}, "", "/space/design-lab?entry=dashboard");
    render(<SpacePage slug="design-lab" />);
    enterName("Ada");

    await waitFor(() => expect(mocks.holder.chalkProps).toMatchObject({ inviteLink: "/space/design-lab#spaceInviteToken=cspi1.account" }));
    expect(mocks.publicClient.arriveBySpacePublicInvite).not.toHaveBeenCalled();
  });

  it("gives a capability token precedence over the account marker and canonicalizes the verified slug", async () => {
    window.history.replaceState({}, "", `/space/wrong-slug?entry=dashboard&name=old#spaceInviteToken=${spacePageTestToken}`);
    mocks.publicClient.arriveBySpacePublicInvite.mockResolvedValueOnce({
      ...spacePageTestArrival,
      space: { ...spacePageTestArrival.space, slug: "verified-slug" },
    });
    render(<SpacePage slug="wrong-slug" />);
    enterName("Ada");

    await waitFor(() => expect(mocks.publicClient.arriveBySpacePublicInvite).toHaveBeenCalledWith(spacePageTestToken, "Ada"));
    expect(mocks.joinDashboardSpace).not.toHaveBeenCalled();
    expect(window.location.pathname).toBe("/space/verified-slug");
    expect(window.location.search).toBe("");
    expect(window.location.hash).toBe(`#spaceInviteToken=${spacePageTestToken}`);
  });

  it("polls a pending arrival, resumes approved access, and renders Chalk", async () => {
    window.history.replaceState({}, "", `/space/design-lab#spaceInviteToken=${spacePageTestToken}`);
    mocks.publicClient.arriveBySpacePublicInvite
      .mockReset()
      .mockResolvedValueOnce({ ...spacePageTestArrival, state: "pending", access: undefined, retry_after: 0 })
      .mockResolvedValueOnce(spacePageTestArrival);
    mocks.publicClient.getSpacePublicInviteArrival.mockResolvedValueOnce({ ...spacePageTestArrival, access: undefined });

    render(<SpacePage slug="design-lab" />);
    enterName("Ada");

    expect(await screen.findByText("Waiting to enter")).toBeDefined();
    await waitFor(() => expect(mocks.publicClient.getSpacePublicInviteArrival).toHaveBeenCalledWith("arrival-11111111"));
    expect(mocks.publicClient.arriveBySpacePublicInvite).toHaveBeenNthCalledWith(2, spacePageTestToken, "Ada", { arrivalHandle: "arrival-11111111" });
    expect(mocks.createPreparedPublicSpace).toHaveBeenLastCalledWith(mocks.publicClient, spacePageTestArrival, { reenter: expect.any(Function) });
    expect(mocks.holder.chalkProps).toBeDefined();
  });

  it("cancels a pending arrival through the public leave operation", async () => {
    window.history.replaceState({}, "", `/space/design-lab#spaceInviteToken=${spacePageTestToken}`);
    mocks.publicClient.arriveBySpacePublicInvite.mockResolvedValueOnce({ ...spacePageTestArrival, state: "pending", access: undefined, retry_after: 60 });

    render(<SpacePage slug="design-lab" />);
    enterName("Ada");
    await screen.findByText("Waiting to enter");

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(mocks.publicClient.leaveSpacePublicInviteArrival).toHaveBeenCalledWith("arrival-11111111"));
    expect(screen.getByRole("button", { name: "Continue" })).toBeDefined();
  });

  it("uses a neutral error for an unavailable invite", async () => {
    window.history.replaceState({}, "", `/space/design-lab#spaceInviteToken=${spacePageTestToken}`);
    mocks.publicClient.arriveBySpacePublicInvite.mockRejectedValueOnce(new Error("secret backend detail"));

    render(<SpacePage slug="design-lab" />);
    enterName("Ada");

    expect((await screen.findByRole("alert")).textContent).toBe("This Space is unavailable. Please check the invite link and try again.");
    expect(screen.getByRole("button", { name: "Continue" })).toBeDefined();
  });

  it("does not attach terminal arrival cleanup to the ordinary leave event", async () => {
    await renderAdmittedSpace();

    expect(mocks.holder.chalkProps).toMatchObject({ diagnosticReference: mocks.diagnosticsReference });
    expect(mocks.holder.chalkProps).not.toHaveProperty("onLeft");
    expect(mocks.prepared.finish).not.toHaveBeenCalled();
  });

  it("fully releases the prepared arrival when the Episode ends", async () => {
    await renderAdmittedSpace();

    const onEpisodeEnded = mocks.holder.chalkProps?.onEpisodeEnded;
    if (typeof onEpisodeEnded !== "function") throw new Error("Chalk did not provide the Episode end callback.");
    act(() => onEpisodeEnded());

    await waitFor(() => expect(mocks.prepared.finish).toHaveBeenCalled());
  });

  it("keeps public arrival cleanup alive on pagehide", async () => {
    await renderAdmittedSpace();

    act(() => window.dispatchEvent(new Event("pagehide")));
    await waitFor(() => expect(mocks.prepared.finish).toHaveBeenCalledWith({ keepalive: true }));
  });
});

function enterName(displayName: string): void {
  fireEvent.change(screen.getByLabelText("Your name"), { target: { value: displayName } });
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
}

async function renderAdmittedSpace(): Promise<void> {
  window.history.replaceState({}, "", `/space/design-lab#spaceInviteToken=${spacePageTestToken}`);
  render(<SpacePage slug="design-lab" />);
  enterName("Ada");
  await waitFor(() => expect(mocks.holder.chalkProps).toBeDefined());
}
