/* @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getSpacePageTestMocks, resetSpacePageTestMocks, spacePageTestArrival, spacePageTestToken } from "../__tests__/space-page.test-support";
import { SpacePage } from "../components/space/SpacePage";

const mocks = getSpacePageTestMocks();

beforeEach(() => resetSpacePageTestMocks());
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("public Space route entry", () => {
  it("creates a public Space at the index route and renders its invite", async () => {
    render(<SpacePage />);
    continueWithName("Ada");

    await waitFor(() => expect(mocks.publicClient.createPublicSpace).toHaveBeenCalledWith("Ada"));
    await waitFor(() => expect(mocks.holder.chalkProps).toMatchObject({ inviteLink: window.location.href, spaceName: "Created Space" }));
  });

  it("uses the capability token on the named route", async () => {
    window.history.replaceState({}, "", `/space/design-lab#spaceInviteToken=${spacePageTestToken}`);
    render(<SpacePage slug="design-lab" />);
    continueWithName("Ada");

    await waitFor(() => expect(mocks.publicClient.arriveBySpacePublicInvite).toHaveBeenCalledWith(spacePageTestToken, "Ada"));
    expect(mocks.publicClient.createPublicSpace).not.toHaveBeenCalled();
    expect(mocks.holder.chalkProps).toMatchObject({ inviteLink: window.location.href, spaceName: "Design Lab" });
  });

  it("leaves a public arrival when Chalk reports that the Participant left", async () => {
    window.history.replaceState({}, "", `/space/design-lab#spaceInviteToken=${spacePageTestToken}`);
    render(<SpacePage slug="design-lab" />);
    continueWithName("Ada");
    await waitFor(() => expect(mocks.holder.chalkProps).toBeDefined());

    (mocks.holder.chalkProps?.onLeft as () => void)();
    await waitFor(() => expect(mocks.prepared.finish).toHaveBeenCalled());
    expect(spacePageTestArrival.arrival_handle).toBe("arrival-11111111");
  });
});

function continueWithName(displayName: string): void {
  fireEvent.change(screen.getByLabelText("Your name"), { target: { value: displayName } });
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
}
