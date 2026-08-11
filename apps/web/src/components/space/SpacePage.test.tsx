/* @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getSpacePageTestMocks, resetSpacePageTestMocks, spacePageTestCredential } from "../../__tests__/space-page.test-support";

import { DashboardSpacePage, SpacePage } from "./SpacePage";

const mocks = getSpacePageTestMocks();

beforeEach(() => {
  resetSpacePageTestMocks();
});

afterEach(() => {
  cleanup();
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
    expect(mocks.createLocalSpaceClient).toHaveBeenCalledWith({ credential: spacePageTestCredential, getAccess: mocks.getAccess, journey: mocks.journey });
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
    expect(mocks.createLocalSpaceClient).toHaveBeenCalledWith({ credential: spacePageTestCredential, getAccess: mocks.dashboardGetAccess, connectionAccess: mocks.connectionAccess, journey: mocks.journey });
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
