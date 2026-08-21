// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import * as publicEntry from "../index";
import { PreviewEntrance, PreviewSpaceView, PreviewStatusSurface } from "./preview-fixtures";
import { createTestClient } from "./test-client";
import { COSMIC_CHALK_THEME } from "../theme";

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

  it("uses fixture devices through the same selectors and join contract as production Entrance", () => {
    const onJoin = vi.fn();
    render(
      <PreviewEntrance
        spaceName="Design review"
        defaultDisplayName="Ada"
        audioInputDevices={[{ deviceId: "preview-mic", label: "Preview microphone" }]}
        videoInputDevices={[{ deviceId: "preview-camera", label: "Preview camera" }]}
        audioOutputDevices={[{ deviceId: "preview-speaker", label: "Preview speaker" }]}
        onJoin={onJoin}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Choose microphone devices" }));
    fireEvent.change(screen.getByRole("combobox", { name: "Microphone input" }), { target: { value: "preview-mic" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Audio output" }), { target: { value: "preview-speaker" } });
    fireEvent.click(screen.getByRole("button", { name: "Choose camera devices" }));
    fireEvent.change(screen.getByRole("combobox", { name: "Camera input" }), { target: { value: "preview-camera" } });
    fireEvent.click(screen.getByRole("button", { name: "Enter Space" }));

    expect(onJoin).toHaveBeenCalledWith({
      displayName: "Ada",
      microphone: true,
      camera: true,
      audioInputDeviceId: "preview-mic",
      videoInputDeviceId: "preview-camera",
      audioOutputDeviceId: "preview-speaker",
    });
  });

  it("never requests media permissions for URL-driven preview states", () => {
    const getUserMedia = vi.fn();
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });

    render(<PreviewEntrance spaceName="Design review" microphone camera defaultDisplayName="Ada" onJoin={() => undefined} />);

    expect(getUserMedia).not.toHaveBeenCalled();
    expect(document.querySelectorAll('button[aria-pressed="true"]')).toHaveLength(2);
  });

  it("renders the canonical joining and pre-live failure Entrance states", () => {
    const { rerender } = render(<PreviewEntrance spaceName="Design review" joining onJoin={() => undefined} />);

    expect(screen.getByRole("heading", { name: "Requesting access" })).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Access request in progress…");

    rerender(<PreviewEntrance spaceName="Design review" previewError="Preview is unavailable." onJoin={() => undefined} />);

    expect(screen.getByRole("heading", { name: "Enter this Space" })).toBeInTheDocument();
    expect(screen.getByText("Preview is unavailable.")).toBeInTheDocument();
  });

  it("uses the shared status surface for leaving, left, and post-live failure", () => {
    const onRetry = vi.fn();
    const { rerender } = render(<PreviewStatusSurface state="leaving" spaceName="Design review" />);

    expect(screen.getByRole("status")).toHaveTextContent("Leaving Design review…");
    expect(screen.queryByRole("button", { name: "Try again" })).not.toBeInTheDocument();

    rerender(<PreviewStatusSurface state="left" spaceName="Design review" onRetry={onRetry} />);
    expect(screen.getByRole("status")).toHaveTextContent("You have left this Space.");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(onRetry).toHaveBeenCalledOnce();

    rerender(<PreviewStatusSurface state="failed" spaceName="Design review" error="The Episode is unavailable." onRetry={onRetry} />);
    expect(screen.getByRole("status")).toHaveTextContent("The Episode is unavailable.");
  });

  it("passes the production theme through the permission-free Entrance adapter", () => {
    render(<PreviewEntrance spaceName="Design review" theme={COSMIC_CHALK_THEME} onJoin={() => undefined} />);

    expect(COSMIC_CHALK_THEME.skin).toBe("chalk");
    expect(document.querySelector("main[data-chalk]")).toHaveAttribute("data-chalk-skin", "chalk");
    expect(document.querySelector("main[data-chalk]")).toHaveAttribute("data-chalk-palette", "cosmic-chalk");
    expect(document.querySelector("main[data-chalk]")).toHaveAttribute("data-chalk-texture", "slate");
  });

  it("accepts caller-owned state for the presentational SpaceView", () => {
    render(<PreviewSpaceView client={createTestClient()} spaceName="Design review" palette="warm-charcoal" texture="paper" />);

    expect(document.querySelector('[data-chalk-palette="warm-charcoal"]')).toHaveAttribute("data-chalk-texture", "paper");
  });

  it("forwards the skin independently of palette and texture to SpaceView", () => {
    render(<PreviewSpaceView client={createTestClient()} spaceName="Design review" skin="chalk" palette="paper-and-ink" texture="none" />);

    expect(document.querySelector("main[data-chalk]")).toHaveAttribute("data-chalk-skin", "chalk");
    expect(document.querySelector("main[data-chalk]")).toHaveAttribute("data-chalk-palette", "paper-and-ink");
    expect(document.querySelector("main[data-chalk]")).toHaveAttribute("data-chalk-texture", "none");
  });

  it("creates a preview client when no client is supplied", () => {
    render(<PreviewSpaceView spaceName="Design review" />);

    expect(document.querySelector("main[data-chalk]")).toBeInTheDocument();
  });
});
