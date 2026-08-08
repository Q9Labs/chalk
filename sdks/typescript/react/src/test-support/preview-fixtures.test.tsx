// @vitest-environment happy-dom

import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import * as publicEntry from "../index";
import { PreviewEntrance, PreviewSpaceView } from "./preview-fixtures";
import { createTestClient } from "./test-client";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("preview fixtures", () => {
  it("keeps controlled preview adapters out of the public entrypoint", () => {
    expect(publicEntry).not.toHaveProperty("PreviewEntrance");
    expect(publicEntry).not.toHaveProperty("PreviewSpaceView");
  });

  it("forwards fixture-controlled device state to Entrance", () => {
    render(<PreviewEntrance spaceName="Design review" microphone={false} camera={false} onJoin={() => undefined} />);

    expect(document.querySelector('button[aria-pressed="false"]')).toBeInTheDocument();
  });

  it("never requests media permissions for URL-driven preview states", () => {
    const getUserMedia = vi.fn();
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });

    render(<PreviewEntrance spaceName="Design review" microphone camera defaultDisplayName="Ada" onJoin={() => undefined} />);

    expect(getUserMedia).not.toHaveBeenCalled();
    expect(document.querySelectorAll('button[aria-pressed="true"]')).toHaveLength(2);
  });

  it("accepts caller-owned state for the presentational SpaceView", () => {
    render(<PreviewSpaceView client={createTestClient()} spaceName="Design review" palette="warm-charcoal" texture="paper" />);

    expect(document.querySelector('[data-chalk-palette="warm-charcoal"]')).toHaveAttribute("data-chalk-texture", "paper");
  });

  it("creates a preview client when no client is supplied", () => {
    render(<PreviewSpaceView spaceName="Design review" />);

    expect(document.querySelector("main[data-chalk]")).toBeInTheDocument();
  });
});
