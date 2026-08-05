/* @vitest-environment jsdom */

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SdkPreviewGallery } from "./SdkPreviewGallery";
import { DEFAULT_PREVIEW_SEARCH } from "./preview-state";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.head.querySelectorAll('link[rel="stylesheet"]').forEach((link) => link.remove());
});

describe("SDK preview adapter boundary", () => {
  it("keeps Entrance media-free and renders a local whiteboard without external stylesheets", async () => {
    const getUserMedia = vi.fn();
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia }, clipboard: { writeText: vi.fn() } });
    const appendChild = vi.spyOn(document.head, "appendChild");
    const onSearchChange = vi.fn();

    render(<SdkPreviewGallery search={{ ...DEFAULT_PREVIEW_SEARCH, view: "entrance", state: "ready" }} onSearchChange={onSearchChange} />);
    expect(screen.getByRole("heading", { name: "Enter this Space" })).toBeTruthy();
    expect(getUserMedia).not.toHaveBeenCalled();

    cleanup();
    render(<SdkPreviewGallery search={{ ...DEFAULT_PREVIEW_SEARCH, view: "space", state: "happy", stage: "whiteboard" }} onSearchChange={onSearchChange} />);
    await waitFor(() => expect(screen.getByTestId("preview-whiteboard")).toBeTruthy());

    expect(getUserMedia).not.toHaveBeenCalled();
    expect(document.head.querySelector('link[href*="jsdelivr"], link[href*="excalidraw"]')).toBeNull();
    expect(appendChild.mock.calls.some(([node]) => node instanceof HTMLLinkElement && /jsdelivr|excalidraw/i.test(node.href))).toBe(false);
  });
});
