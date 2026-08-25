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
    const navigatePublicSpace = vi.fn(async () => undefined);
    render(<SpacePage slug="design-lab" navigatePublicSpace={navigatePublicSpace} />);
    enterName(" Ada ");

    await waitFor(() => expect(mocks.publicClient.arriveBySpacePublicInvite).toHaveBeenCalledWith(spacePageTestToken, "Ada"));
    await waitFor(() => expect(navigatePublicSpace).toHaveBeenCalledWith("design-lab", `${window.location.origin}/space/design-lab#spaceInviteToken=${spacePageTestToken}`));
    expect(mocks.publicClient.createPublicSpace).not.toHaveBeenCalled();
    await waitFor(() => expect(mocks.holder.chalkProps).toMatchObject({ inviteLink: window.location.href, spaceName: "Design Lab" }));
  });

  it("finishes prepared access on page hide", async () => {
    window.history.replaceState({}, "", `/space/design-lab#spaceInviteToken=${spacePageTestToken}`);
    const view = render(<SpacePage slug="design-lab" />);
    enterName("Ada");
    await waitFor(() => expect(mocks.holder.chalkProps).toBeDefined());

    window.dispatchEvent(new Event("pagehide"));
    await waitFor(() => expect(mocks.prepared.finish).toHaveBeenCalledWith({ keepalive: true }));
    view.unmount();
  });
});

describe("account Space admission", () => {
  it("shows and approves public arrivals inside the Space", async () => {
    window.history.replaceState({}, "", "/space/design-lab?entry=dashboard");
    mocks.joinDashboardSpace.mockResolvedValue({
      credential: { apiBaseURL: "https://api.chalk.test", tenantID: "tenant-1", space: "space-1", access: {}, participantGeneration: 1 },
      getAccess: vi.fn(),
      leave: vi.fn(async () => undefined),
    });
    mocks.listSpacePublicAdmissionRequests.mockResolvedValueOnce({ requests: [] }).mockResolvedValue({ requests: [{ request_handle: "arrival-1", display_name: "Ada", requested_at: "2026-08-25T10:00:00Z", expires_at: "2026-08-25T10:05:00Z", state: "pending" }] });

    render(<SpacePage slug="design-lab" />);
    enterName("Owner");

    await waitFor(() => expect(mocks.listSpacePublicAdmissionRequests).toHaveBeenCalledTimes(2), { timeout: 2_500 });
    const admissionControl = readAdmissionControl();
    if (admissionControl.requests.length !== 1) throw new Error("missing admission request");
    await admissionControl.admit("arrival-1");

    expect(mocks.approveSpacePublicAdmissionRequest).toHaveBeenCalledWith({ tenantID: "tenant-1", spaceID: "space-1", requestHandle: "arrival-1" });
  });

  it("keeps a public arrival visible and reports a failed decision", async () => {
    window.history.replaceState({}, "", "/space/design-lab?entry=dashboard");
    mocks.joinDashboardSpace.mockResolvedValue({
      credential: { apiBaseURL: "https://api.chalk.test", tenantID: "tenant-1", space: "space-1", access: {}, participantGeneration: 1 },
      getAccess: vi.fn(),
      leave: vi.fn(async () => undefined),
    });
    mocks.listSpacePublicAdmissionRequests.mockResolvedValue({ requests: [{ request_handle: "arrival-1", display_name: "Ada", requested_at: "2026-08-25T10:00:00Z", expires_at: "2026-08-25T10:05:00Z", state: "pending" }] });
    mocks.approveSpacePublicAdmissionRequest.mockRejectedValue(new Error("network unavailable"));

    render(<SpacePage slug="design-lab" />);
    enterName("Owner");

    await waitFor(() => expect(readAdmissionControl().requests).toHaveLength(1));
    await readAdmissionControl().admit("arrival-1");

    await waitFor(() => expect(mocks.holder.chalkProps?.admissionControl).toMatchObject({ error: "Could not update this admission request. Try again.", requests: [{ id: "arrival-1" }] }));
    expect(mocks.journey.recordDiagnostic).toHaveBeenCalledWith({ category: "network", code: "space.public_admission_decision_failed", phase: "signaling", state: "failed" });
  });
});

function enterName(displayName: string): void {
  fireEvent.change(screen.getByLabelText("Your name"), { target: { value: displayName } });
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
}

function readAdmissionControl(): { readonly requests: readonly unknown[]; readonly admit: (requestID: string) => Promise<void> } {
  const admissionControl = mocks.holder.chalkProps?.admissionControl;
  if (!admissionControl || typeof admissionControl !== "object" || !("requests" in admissionControl) || !Array.isArray(admissionControl.requests) || !("admit" in admissionControl) || typeof admissionControl.admit !== "function") {
    throw new Error("missing admission control");
  }
  const requests = admissionControl.requests;
  const admit = admissionControl.admit;
  return {
    requests,
    admit: async (requestID: string) => {
      await admit(requestID);
    },
  };
}
