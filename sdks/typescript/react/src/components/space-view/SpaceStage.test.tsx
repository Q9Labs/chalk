// @vitest-environment happy-dom

import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SpaceStage } from "./SpaceStage";

const stageSpy = vi.hoisted(() => vi.fn(() => <div data-testid="stage" />));

vi.mock("../../bindings/hooks", () => ({
  useSpaceClient: () => ({
    media: { setScreenShareEnabled: vi.fn() },
    participants: { stopScreenShare: vi.fn() },
  }),
}));
vi.mock("../stage/Stage", () => ({ Stage: stageSpy }));

afterEach(() => {
  cleanup();
  stageSpy.mockClear();
});

describe("SpaceStage", () => {
  it("presents the Episode-wide Board above a local Grid layout and stale pin", () => {
    render(<SpaceStage tiles={[]} layout="grid" whiteboard={{ isOpen: true, props: {} }} />);

    expect(stageSpy).toHaveBeenCalledWith(expect.objectContaining({ layout: "presentation", pinnedId: "whiteboard" }), undefined);
  });

  it("preserves the selected layout while the Board is closed", () => {
    render(<SpaceStage tiles={[]} layout="grid" />);

    expect(stageSpy).toHaveBeenCalledWith(expect.objectContaining({ layout: "grid", pinnedId: undefined }), undefined);
  });
});
