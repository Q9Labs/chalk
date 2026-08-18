// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PreviewGalleryToolbar } from "./PreviewGalleryToolbar";
import { DEFAULT_PREVIEW_SEARCH, ENTRANCE_STATES, patchPreviewSearch, SPACE_STATES, type PreviewSearch } from "./preview-state";

afterEach(cleanup);

function Harness({ initial = DEFAULT_PREVIEW_SEARCH }: { readonly initial?: PreviewSearch }) {
  const [search, setSearch] = useState(initial);
  return <PreviewGalleryToolbar search={search} onChange={(patch) => setSearch((current) => patchPreviewSearch(current, patch))} />;
}

describe("PreviewGalleryToolbar", () => {
  it("links every Entrance and Space state with a real preview URL", () => {
    render(<Harness initial={{ ...DEFAULT_PREVIEW_SEARCH, view: "space", state: "happy" }} />);

    const entranceLinks = within(screen.getByRole("navigation", { name: "Entrance states" })).getAllByRole("link");
    const spaceLinks = within(screen.getByRole("navigation", { name: "Space states" })).getAllByRole("link");

    expect(entranceLinks).toHaveLength(ENTRANCE_STATES.length);
    expect(spaceLinks).toHaveLength(SPACE_STATES.length);
    expect(
      within(screen.getByRole("navigation", { name: "Entrance states" }))
        .getByRole("link", { name: "Warning" })
        .getAttribute("href"),
    ).toContain("state=warning");
    expect(spaceLinks.find((link) => link.textContent === "Reconnecting")?.getAttribute("href")).toContain("state=reconnecting");
  });

  it("emits patches for product-shaped controls", () => {
    const onChange = vi.fn();
    render(<PreviewGalleryToolbar search={DEFAULT_PREVIEW_SEARCH} onChange={onChange} />);

    expect(screen.getByLabelText("Skin").querySelector('option[value="classic"]')?.textContent).toBe("Classic");
    expect(screen.getByLabelText("Skin").querySelector('option[value="chalk"]')?.getAttribute("title")).toContain("Hand-drawn");

    fireEvent.change(screen.getByLabelText("View"), { target: { value: "space" } });
    fireEvent.change(screen.getByLabelText("Participants"), { target: { value: "5" } });
    fireEvent.change(screen.getByLabelText("Chat data"), { target: { value: "failure" } });
    fireEvent.change(screen.getByLabelText("Stage"), { target: { value: "whiteboard" } });
    fireEvent.change(screen.getByLabelText("Panel"), { target: { value: "chat" } });
    fireEvent.change(screen.getByLabelText("Dialog"), { target: { value: "settings" } });
    fireEvent.change(screen.getByLabelText("Layout"), { target: { value: "grid" } });
    fireEvent.change(screen.getByLabelText("Skin"), { target: { value: "chalk" } });
    fireEvent.change(screen.getByLabelText("Palette"), { target: { value: "midnight" } });
    fireEvent.change(screen.getByLabelText("Texture"), { target: { value: "soft-dots" } });
    fireEvent.change(screen.getByLabelText("Toast"), { target: { value: "warning" } });
    fireEvent.click(screen.getByLabelText("Microphone"));
    fireEvent.click(screen.getByLabelText("Camera"));
    fireEvent.click(screen.getByLabelText("Raised hand"));

    expect(onChange).toHaveBeenCalledWith({ view: "space", state: "happy" });
    expect(onChange).toHaveBeenCalledWith({ participants: 5 });
    expect(onChange).toHaveBeenCalledWith({ chat: "failure" });
    expect(onChange).toHaveBeenCalledWith({ stage: "whiteboard" });
    expect(onChange).toHaveBeenCalledWith({ panel: "chat" });
    expect(onChange).toHaveBeenCalledWith({ dialog: "settings" });
    expect(onChange).toHaveBeenCalledWith({ layout: "grid" });
    expect(onChange).toHaveBeenCalledWith({ skin: "chalk" });
    expect(onChange).toHaveBeenCalledWith({ palette: "midnight" });
    expect(onChange).toHaveBeenCalledWith({ texture: "soft-dots" });
    expect(onChange).toHaveBeenCalledWith({ toast: "warning" });
    expect(onChange).toHaveBeenCalledWith({ mic: false });
    expect(onChange).toHaveBeenCalledWith({ camera: false });
    expect(onChange).toHaveBeenCalledWith({ hand: true });
  });

  it("changes direct states in place while keeping real link targets", () => {
    const onChange = vi.fn();
    render(<PreviewGalleryToolbar search={DEFAULT_PREVIEW_SEARCH} onChange={onChange} />);

    const emptyStateLink = within(screen.getByRole("navigation", { name: "Space states" })).getByRole("link", { name: "Empty" });
    fireEvent.click(emptyStateLink);

    expect(emptyStateLink.getAttribute("href")).toBe("/sdk-preview?view=space&state=empty");
    expect(onChange).toHaveBeenCalledWith({ view: "space", state: "empty" });
  });

  it("keeps only the show button keyboard reachable while chrome is hidden", () => {
    const { container } = render(<Harness initial={{ ...DEFAULT_PREVIEW_SEARCH, chrome: "hidden" }} />);

    const showButton = screen.getByRole("button", { name: "Show preview controls" });
    expect(showButton).not.toBeNull();
    expect(showButton.parentElement?.className).toContain("bottom-24");
    expect(showButton.parentElement?.className).toContain("sm:bottom-4");
    expect(screen.queryByRole("region", { name: "Preview controls" })).toBeNull();
    expect(container.querySelectorAll("a, select, input")).toHaveLength(0);

    fireEvent.click(screen.getByRole("button", { name: "Show preview controls" }));
    expect(screen.getByRole("region", { name: "Preview controls" })).not.toBeNull();
    expect(screen.getByRole("button", { name: "Hide preview controls" })).not.toBeNull();
    expect(screen.getByRole("region", { name: "Preview controls" }).parentElement?.className).toContain("bottom-24");

    fireEvent.click(screen.getByRole("button", { name: "Hide preview controls" }));
    expect(screen.getByRole("button", { name: "Show preview controls" })).not.toBeNull();
    expect(container.querySelectorAll("a, select, input")).toHaveLength(0);
  });
});
