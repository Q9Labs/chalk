/* @vitest-environment jsdom */

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { getSpacePageTestMocks, resetSpacePageTestMocks } from "../../__tests__/space-page.test-support";
import { spacePageTestToken } from "../../__tests__/space-page.fixture";
import { SpacePage } from "./SpacePage";

const reloadAfterChunkLoadFailure = vi.hoisted(() => vi.fn((_reason: unknown) => false));
vi.mock("../../lib/chunkReload", () => ({ reloadAfterChunkLoadFailure }));
vi.mock("./SpaceCall", () => {
  throw new Error("Failed to fetch dynamically imported module");
});

const mocks = getSpacePageTestMocks();
const connectionError = "Chalk could not connect. Check your connection and try entering again.";

beforeEach(() => resetSpacePageTestMocks());
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

async function joinAsAda(): Promise<ReturnType<typeof render>> {
  window.history.replaceState({}, "", `/space/design-lab#spaceInviteToken=${spacePageTestToken}`);
  const view = render(<SpacePage slug="design-lab" />);
  await act(async () => {
    fireEvent.change(screen.getByLabelText("Your name"), { target: { value: "Ada" } });
    fireEvent.click(screen.getByRole("button", { name: "Join call" }));
  });
  await waitFor(() => expect(screen.getByText(connectionError)).toBeDefined());
  return view;
}

it("releases an admitted arrival and offers a retry when the call UI cannot load", async () => {
  await joinAsAda();
  await waitFor(() => expect(reloadAfterChunkLoadFailure).toHaveBeenCalledOnce());
  expect(mocks.prepared.finish).toHaveBeenCalledOnce();
  expect(mocks.createLocalSpaceClient).not.toHaveBeenCalled();
  expect(mocks.Chalk).not.toHaveBeenCalled();
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Ask again" })));
  await waitFor(() => expect(mocks.publicClient.arriveBySpacePublicInvite).toHaveBeenCalledTimes(2));
});

it("releases the arrival again before a retry when the first release fails", async () => {
  mocks.prepared.finish.mockRejectedValueOnce(new Error("offline"));
  await joinAsAda();
  await waitFor(() => expect(mocks.prepared.finish).toHaveBeenCalledOnce());
  expect(reloadAfterChunkLoadFailure).not.toHaveBeenCalled();
  expect(mocks.publicClient.arriveBySpacePublicInvite).toHaveBeenCalledOnce();
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Ask again" })));
  await waitFor(() => expect(mocks.publicClient.arriveBySpacePublicInvite).toHaveBeenCalledTimes(2));
  expect(mocks.prepared.finish.mock.calls.length).toBeGreaterThanOrEqual(2);
});

it("releases the arrival on unmount when the release after a failed call load failed", async () => {
  mocks.prepared.finish.mockRejectedValueOnce(new Error("offline"));
  const view = await joinAsAda();
  await waitFor(() => expect(mocks.prepared.finish).toHaveBeenCalledOnce());
  await act(async () => view.unmount());
  await waitFor(() => expect(mocks.prepared.finish).toHaveBeenCalledTimes(2));
});
