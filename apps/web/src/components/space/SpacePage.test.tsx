/* @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getSpacePageTestMocks, resetSpacePageTestMocks, spacePageTestCredential } from "../../__tests__/space-page.test-support";

import { SpacePage } from "./SpacePage";

const mocks = getSpacePageTestMocks();

beforeEach(() => {
  resetSpacePageTestMocks();
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
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
    expect(mocks.holder.chalkProps).toMatchObject({ client: mocks.client, displayName: "Ada", entrance: false, spaceName: "Local Space" });
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
