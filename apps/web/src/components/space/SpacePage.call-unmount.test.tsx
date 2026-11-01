/* @vitest-environment jsdom */

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { getSpacePageTestMocks, resetSpacePageTestMocks } from "../../__tests__/space-page.test-support";
import { spacePageTestToken } from "../../__tests__/space-page.fixture";
import { SpacePage } from "./SpacePage";

// Holds the call module open after admission.
vi.mock("./SpaceCall", () => new Promise(() => {}));

const mocks = getSpacePageTestMocks();

beforeEach(() => resetSpacePageTestMocks());
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

it("releases an admitted arrival when the route unmounts during call-module loading", async () => {
  window.history.replaceState({}, "", `/space/design-lab#spaceInviteToken=${spacePageTestToken}`);
  const view = render(<SpacePage slug="design-lab" />);
  await act(async () => {
    fireEvent.change(screen.getByLabelText("Your name"), { target: { value: "Ada" } });
    fireEvent.click(screen.getByRole("button", { name: "Join call" }));
  });
  await waitFor(() => expect(mocks.createPreparedPublicSpace).toHaveBeenCalledOnce());
  await act(async () => view.unmount());
  await waitFor(() => expect(mocks.prepared.finish).toHaveBeenCalledOnce(), { timeout: 250 });
});
