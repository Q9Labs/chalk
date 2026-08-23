/* @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
  it("admits a guest through a capability link and renders the canonical Space", async () => {
    window.history.replaceState({}, "", `/space/design-lab#spaceInviteToken=${spacePageTestToken}`);
    render(<SpacePage slug="design-lab" />);
    enterName(" Ada ");

    await waitFor(() => expect(mocks.publicClient.arriveBySpacePublicInvite).toHaveBeenCalledWith(spacePageTestToken, "Ada"));
    expect(mocks.publicClient.createPublicSpace).not.toHaveBeenCalled();
    await waitFor(() => expect(mocks.holder.chalkProps).toMatchObject({ inviteLink: window.location.href, spaceName: "Design Lab" }));
  });

  it("finishes prepared access when the admitted Space page unmounts", async () => {
    window.history.replaceState({}, "", `/space/design-lab#spaceInviteToken=${spacePageTestToken}`);
    const view = render(<SpacePage slug="design-lab" />);
    enterName("Ada");
    await waitFor(() => expect(mocks.holder.chalkProps).toBeDefined());

    view.unmount();
    await waitFor(() => expect(mocks.prepared.finish).toHaveBeenCalledOnce());
  });
});

function enterName(displayName: string): void {
  fireEvent.change(screen.getByLabelText("Your name"), { target: { value: displayName } });
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
}
