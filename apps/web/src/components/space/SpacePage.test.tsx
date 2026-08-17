/* @vitest-environment jsdom */

import { StrictMode } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { dashboardSpaceTestAccess, getSpacePageTestMocks, resetSpacePageTestMocks, spacePageTestCredential } from "../../__tests__/space-page.test-support";
import { DashboardAPIError } from "../../lib/dashboard-api";

import { DashboardSpacePage, SpacePage } from "./SpacePage";

const mocks = getSpacePageTestMocks();

beforeEach(() => {
  resetSpacePageTestMocks();
});

afterEach(async () => {
  cleanup();
  await new Promise((resolve) => setTimeout(resolve, 0));
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("SpacePage", () => {
  it("normalizes the query display name before building the app-owned SpaceClient", async () => {
    window.history.replaceState({}, "", "/space?name=%20Ada%20");

    render(<SpacePage />);

    expect((screen.getByLabelText("Your name") as HTMLInputElement).value).toBe(" Ada ");
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(mocks.holder.chalkProps).toBeDefined());

    expect(mocks.createParticipantCredential).toHaveBeenCalledWith("Ada", undefined, mocks.journey);
    expect(mocks.telemetry.configureApiBaseURL).toHaveBeenCalledWith(spacePageTestCredential.apiBaseURL);
    expect(mocks.createLocalSpaceClient).toHaveBeenCalledWith({ credential: spacePageTestCredential, getAccess: mocks.getAccess, connectionAccess: mocks.brokerConnectionAccess, journey: mocks.journey });
    expect(mocks.holder.chalkProps).toMatchObject({ client: mocks.client, displayName: "Ada", entrance: true, spaceName: "Local Space" });
    expect(mocks.useEpisodeDiagnosticsAvailability).toHaveBeenCalledWith({ diagnosticReference: `chalk.episode:${mocks.episodeID}` });
    (mocks.holder.chalkProps?.onOpenDiagnostics as (() => void) | undefined)?.();
    expect(mocks.open).toHaveBeenCalledWith(mocks.diagnosticsPath, "_blank", "noopener");
    expect(document.querySelector("main")?.className).toContain("h-dvh");
  });

  it("supplies the same live Episode debugger entry for the Dashboard path", async () => {
    mocks.localStorage.getItem.mockReturnValue("tenant-1");
    render(<DashboardSpacePage slug="design-space" />);

    fireEvent.change(screen.getByLabelText("Your name"), { target: { value: "Ada" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(mocks.holder.chalkProps).toBeDefined());

    expect(mocks.joinDashboardSpace).toHaveBeenCalledWith("tenant-1", "design-space", "Ada", mocks.journey);
    expect(mocks.createLocalSpaceClient).toHaveBeenCalledWith({ credential: dashboardSpaceTestAccess.credential, getAccess: mocks.dashboardGetAccess, connectionAccess: mocks.dashboardConnectionAccess, journey: mocks.journey });
    expect(mocks.holder.chalkProps).toMatchObject({ onOpenDiagnostics: expect.any(Function), spaceName: "design-space" });
    (mocks.holder.chalkProps?.onOpenDiagnostics as (() => void) | undefined)?.();
    expect(mocks.open).toHaveBeenCalledWith(mocks.diagnosticsPath, "_blank", "noopener");
  });

  it("keeps diagnostics absent when the current Episode is unavailable", async () => {
    mocks.useEpisodeDiagnosticsAvailability.mockReturnValue({ path: undefined, status: "unavailable", supported: true, retry: vi.fn() });
    render(<SpacePage />);

    fireEvent.change(screen.getByLabelText("Your name"), { target: { value: "Ada" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(mocks.holder.chalkProps).toBeDefined());

    expect(mocks.holder.chalkProps?.onOpenDiagnostics).toBeUndefined();
  });

  it("surfaces a failed credential request while keeping the arrival form available", async () => {
    mocks.createParticipantCredential.mockRejectedValueOnce(new Error("broker unavailable"));

    render(<SpacePage />);
    fireEvent.change(screen.getByLabelText("Your name"), { target: { value: "Ada" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    expect((await screen.findByRole("alert")).textContent).toContain("broker unavailable");
    expect((screen.getByRole("button", { name: "Continue" }) as HTMLButtonElement).disabled).toBe(false);
    expect(mocks.createLocalSpaceClient).not.toHaveBeenCalled();
  });
});

describe("DashboardSpacePage", () => {
  it("keeps the signed-in by-slug join and names the Space from its slug", async () => {
    render(
      <StrictMode>
        <DashboardSpacePage slug="design-lab" />
      </StrictMode>,
    );
    enterName(" Ada ");
    await waitFor(() => expect(mocks.holder.chalkProps).toBeDefined());

    expect(mocks.joinDashboardSpace).toHaveBeenCalledWith("tenant-1", "design-lab", "Ada", mocks.journey);
    expect(mocks.createParticipantCredential).not.toHaveBeenCalled();
    expect(mocks.createLocalSpaceClient).toHaveBeenCalledWith({ credential: dashboardSpaceTestAccess.credential, getAccess: mocks.dashboardGetAccess, connectionAccess: mocks.dashboardConnectionAccess, journey: mocks.journey });
    expect(mocks.holder.chalkProps).toMatchObject({ spaceName: "design-lab" });
    expect(mocks.dashboardLeave).not.toHaveBeenCalled();
    expect(mocks.holder.chalkProps?.inviteLink).toBeUndefined();
  });

  it("keeps a token-bearing invite link while a signed-in Account joins by slug", async () => {
    window.history.replaceState({}, "", `/space/design-lab?name=Private#spaceInviteToken=${spacePageTestCredential.spaceInviteToken}&ignored=value`);
    render(<DashboardSpacePage slug="design-lab" />);
    enterName("Ada");
    await waitFor(() => expect(mocks.holder.chalkProps).toBeDefined());

    expect(mocks.joinDashboardSpace).toHaveBeenCalledOnce();
    expect(mocks.createParticipantCredential).not.toHaveBeenCalled();
    expect(mocks.holder.chalkProps?.inviteLink).toBe(`${window.location.origin}/space/design-lab#spaceInviteToken=${spacePageTestCredential.spaceInviteToken}`);
  });

  it("uses the invite token when the visitor has no signed-in Account", async () => {
    setNamedInviteLocation();
    mocks.listAllAccountTenants.mockRejectedValueOnce(new DashboardAPIError(401, "access.unauthenticated", "Authentication required"));

    render(<DashboardSpacePage slug="design-lab" />);
    enterName("Ada");
    await waitFor(() => expect(mocks.holder.chalkProps).toBeDefined());

    expect(mocks.joinDashboardSpace).not.toHaveBeenCalled();
    expect(mocks.createParticipantCredential).toHaveBeenCalledWith("Ada", spacePageTestCredential.spaceInviteToken, mocks.journey);
    expect(mocks.holder.chalkProps).toMatchObject({ spaceName: "design-lab", inviteLink: window.location.href });
  });

  it("uses the invite token when a stale Tenant hint reaches an unauthenticated join", async () => {
    setNamedInviteLocation();
    mocks.localStorage.getItem.mockReturnValue("tenant-old");
    mocks.joinDashboardSpace.mockRejectedValueOnce(Object.assign(new Error("Authentication required"), { status: 401 }));

    render(<DashboardSpacePage slug="design-lab" />);
    enterName("Ada");
    await waitFor(() => expect(mocks.holder.chalkProps).toBeDefined());

    expect(mocks.joinDashboardSpace).toHaveBeenCalledWith("tenant-old", "design-lab", "Ada", mocks.journey);
    expect(mocks.createParticipantCredential).toHaveBeenCalledWith("Ada", spacePageTestCredential.spaceInviteToken, mocks.journey);
  });

  it("does not use broker access when an unauthenticated request has no invite token", async () => {
    window.history.replaceState({}, "", "/space/design-lab");
    mocks.listAllAccountTenants.mockRejectedValueOnce(new DashboardAPIError(401, "access.unauthenticated", "Authentication required"));

    render(<DashboardSpacePage slug="design-lab" />);
    enterName("Ada");

    expect((await screen.findByRole("alert")).textContent).toContain("Authentication required");
    expect(mocks.createParticipantCredential).not.toHaveBeenCalled();
    expect(mocks.createLocalSpaceClient).not.toHaveBeenCalled();
  });

  it("does not use the invite token when the Account lacks Tenant access", async () => {
    setNamedInviteLocation();
    mocks.joinDashboardSpace.mockRejectedValueOnce(Object.assign(new Error("Tenant access required"), { status: 403 }));

    render(<DashboardSpacePage slug="design-lab" />);
    enterName("Ada");

    expect((await screen.findByRole("alert")).textContent).toContain("Tenant access required");
    expect(mocks.createParticipantCredential).not.toHaveBeenCalled();
    expect(mocks.createLocalSpaceClient).not.toHaveBeenCalled();
  });

  it("surfaces a failed Dashboard join and re-enables Continue", async () => {
    mocks.joinDashboardSpace.mockRejectedValueOnce(new Error("Media access is unavailable."));

    render(
      <StrictMode>
        <DashboardSpacePage slug="design-lab" />
      </StrictMode>,
    );
    enterName("Ada");

    expect((await screen.findByRole("alert")).textContent).toContain("Media access is unavailable.");
    expect((screen.getByRole("button", { name: "Continue" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("clears a visitor invite only after credential cleanup succeeds", async () => {
    setNamedInviteLocation();
    mocks.listAllAccountTenants.mockRejectedValueOnce(new DashboardAPIError(401, "access.unauthenticated", "Authentication required"));
    let resolveCleanup!: () => void;
    const cleanupPromise = new Promise<void>((resolve) => {
      resolveCleanup = resolve;
    });
    mocks.cleanupParticipantCredential.mockReturnValueOnce(cleanupPromise);

    render(<DashboardSpacePage slug="design-lab" />);
    enterName("Ada");
    await waitFor(() => expect(mocks.holder.chalkProps).toBeDefined());

    (mocks.holder.chalkProps?.onLeft as () => void)();
    expect(window.location.hash).toBe(`#spaceInviteToken=${spacePageTestCredential.spaceInviteToken}`);
    resolveCleanup();
    await waitFor(() => expect(window.location.hash).toBe(""));
  });
});

function enterName(displayName: string): void {
  fireEvent.change(screen.getByLabelText("Your name"), { target: { value: displayName } });
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
}

function setNamedInviteLocation(): void {
  window.history.replaceState({}, "", `/space/design-lab#spaceInviteToken=${spacePageTestCredential.spaceInviteToken}`);
}
