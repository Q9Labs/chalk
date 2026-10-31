/* @vitest-environment jsdom */

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { getSpacePageTestMocks, resetSpacePageTestMocks } from "../../__tests__/space-page.test-support";
import { spacePageTestToken } from "../../__tests__/space-page.fixture";
import { SpacePage } from "./SpacePage";

vi.mock("./SpaceCall", () => {
  throw new Error("Failed to fetch dynamically imported module");
});

const mocks = getSpacePageTestMocks();

beforeEach(() => resetSpacePageTestMocks());
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

it("releases an admitted arrival and offers a retry when the call UI cannot load", async () => {
  window.history.replaceState({}, "", `/space/design-lab#spaceInviteToken=${spacePageTestToken}`);
  render(<SpacePage slug="design-lab" />);
  await act(async () => {
    fireEvent.change(screen.getByLabelText("Your name"), { target: { value: "Ada" } });
    fireEvent.click(screen.getByRole("button", { name: "Join call" }));
  });
  await waitFor(() => expect(screen.getByText("Chalk could not connect. Check your connection and try entering again.")).toBeDefined());
  expect(mocks.prepared.finish).toHaveBeenCalledTimes(1);
  expect(mocks.createLocalSpaceClient).not.toHaveBeenCalled();
  expect(mocks.Chalk).not.toHaveBeenCalled();
  await waitFor(() => expect(screen.getByRole("button", { name: "Ask again" })).toBeDefined());
});
