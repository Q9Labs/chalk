/* @vitest-environment jsdom */

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SdkPreviewGallery } from "./SdkPreviewGallery";
import { DEFAULT_PREVIEW_SEARCH } from "./preview-state";

class PreviewMediaStream {
  private readonly tracks: readonly MediaStreamTrack[];

  constructor(tracks: readonly MediaStreamTrack[] = []) {
    this.tracks = tracks;
  }

  getTracks(): MediaStreamTrack[] {
    return [...this.tracks];
  }

  getAudioTracks(): MediaStreamTrack[] {
    return this.tracks.filter((track) => track.kind === "audio");
  }

  getVideoTracks(): MediaStreamTrack[] {
    return this.tracks.filter((track) => track.kind === "video");
  }
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.head.querySelectorAll('link[rel="stylesheet"]').forEach((link) => link.remove());
});

describe("SDK preview adapter boundary", () => {
  it("keeps Entrance media-free and renders the real local whiteboard adapter", async () => {
    const getUserMedia = vi.fn();
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
    vi.stubGlobal("MediaStream", PreviewMediaStream);
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia }, clipboard: { writeText: vi.fn() } });
    const onSearchChange = vi.fn();

    render(<SdkPreviewGallery search={{ ...DEFAULT_PREVIEW_SEARCH, view: "entrance", state: "ready" }} onSearchChange={onSearchChange} />);
    expect(screen.getByRole("heading", { name: "Enter this Space" })).toBeTruthy();
    expect(getUserMedia).not.toHaveBeenCalled();

    cleanup();
    render(<SdkPreviewGallery search={{ ...DEFAULT_PREVIEW_SEARCH, view: "space", state: "happy", stage: "whiteboard" }} onSearchChange={onSearchChange} />);
    await waitFor(() => expect(screen.getByRole("region", { name: "Space stage" })).toBeTruthy());
    expect(screen.queryByTestId("preview-whiteboard")).toBeNull();

    expect(getUserMedia).not.toHaveBeenCalled();
  });
});
