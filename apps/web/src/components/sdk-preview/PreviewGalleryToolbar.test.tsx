// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PreviewGalleryToolbar } from "./PreviewGalleryToolbar";
import { DEFAULT_PREVIEW_SEARCH, ENTRANCE_STATES, patchPreviewSearch, SPACE_STATES, type PreviewSearch } from "./preview-state";

const VISIBLE: PreviewSearch = { ...DEFAULT_PREVIEW_SEARCH, chrome: "visible" };

const storedValues = new Map<string, string>();
const testStorage: Storage = {
  get length() {
    return storedValues.size;
  },
  clear: () => storedValues.clear(),
  getItem: (key) => storedValues.get(key) ?? null,
  key: (index) => Array.from(storedValues.keys())[index] ?? null,
  removeItem: (key) => storedValues.delete(key),
  setItem: (key, value) => storedValues.set(key, value),
};

beforeEach(() => {
  Object.defineProperty(window, "localStorage", { configurable: true, value: testStorage });
  testStorage.clear();
});
afterEach(() => {
  cleanup();
  testStorage.clear();
});

function Harness({ initial = VISIBLE }: { readonly initial?: PreviewSearch }) {
  const [search, setSearch] = useState(initial);
  return <PreviewGalleryToolbar search={search} onChange={(patch) => setSearch((current) => patchPreviewSearch(current, patch))} />;
}

function openTab(name: string) {
  fireEvent.click(screen.getByRole("tab", { name }));
}

function pickChip(group: string, option: string) {
  fireEvent.click(within(screen.getByRole("group", { name: group })).getByRole("radio", { name: option }));
}

describe("PreviewGalleryToolbar", () => {
  it("links every Entrance and Space state with a real preview URL", () => {
    render(<Harness initial={{ ...VISIBLE, view: "space", state: "happy" }} />);
    openTab("States");

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
    expect(
      within(screen.getByRole("navigation", { name: "Space states" }))
        .getByRole("link", { name: "Happy" })
        .getAttribute("aria-current"),
    ).toBe("page");
  });

  it("changes direct states in place while keeping real link targets", () => {
    const onChange = vi.fn();
    render(<PreviewGalleryToolbar search={VISIBLE} onChange={onChange} />);
    openTab("States");

    const emptyStateLink = within(screen.getByRole("navigation", { name: "Space states" })).getByRole("link", { name: "Empty" });
    fireEvent.click(emptyStateLink);

    expect(emptyStateLink.getAttribute("href")).toBe("/sdk-preview?view=space&state=empty&chrome=visible");
    expect(onChange).toHaveBeenCalledWith({ view: "space", state: "empty" });
  });

  it("emits patches from one-click chips, switches, and selects across tabs", () => {
    const onChange = vi.fn();
    render(<PreviewGalleryToolbar search={VISIBLE} onChange={onChange} />);

    openTab("Space");
    pickChip("Participants", "5");
    pickChip("Layout", "Grid");
    pickChip("Stage", "Whiteboard");
    fireEvent.click(screen.getByRole("switch", { name: "Stage background" }));
    pickChip("Panel", "Chat");
    pickChip("Dialog", "Settings");
    pickChip("Toast", "Warning");
    pickChip("Chat data", "Failure");
    pickChip("Screen share", "Remote");
    pickChip("Incoming media request", "Start camera");
    pickChip("Admission queue", "Waiting");
    fireEvent.change(screen.getByLabelText("Active speaker"), { target: { value: "nora" } });

    openTab("Media");
    pickChip("Microphone", "Disabled");
    pickChip("Camera", "Failed");
    fireEvent.click(screen.getByRole("switch", { name: "Raised hand" }));

    openTab("Access");
    pickChip("Role", "Owner");
    pickChip("Capability", "Observer");
    fireEvent.click(screen.getByRole("switch", { name: /Diagnostics/ }));
    fireEvent.click(screen.getByRole("button", { name: "Feature Admission" }));

    openTab("Look");
    expect(
      within(screen.getByRole("group", { name: "Skin" }))
        .getByRole("radio", { name: "Chalk" })
        .closest("label")
        ?.getAttribute("title"),
    ).toContain("Hand-drawn");
    pickChip("Skin", "Chalk");
    fireEvent.change(screen.getByLabelText("Palette"), { target: { value: "oled-signal" } });
    pickChip("Texture", "Slate");

    expect(onChange).toHaveBeenCalledWith({ participants: 5 });
    expect(onChange).toHaveBeenCalledWith({ layout: "grid" });
    expect(onChange).toHaveBeenCalledWith({ stage: "whiteboard" });
    expect(onChange).toHaveBeenCalledWith({ stageBackground: false });
    expect(onChange).toHaveBeenCalledWith({ panel: "chat" });
    expect(onChange).toHaveBeenCalledWith({ dialog: "settings" });
    expect(onChange).toHaveBeenCalledWith({ toast: "warning" });
    expect(onChange).toHaveBeenCalledWith({ chat: "failure" });
    expect(onChange).toHaveBeenCalledWith({ screenShare: "remote" });
    expect(onChange).toHaveBeenCalledWith({ incomingMediaRequest: "start-camera" });
    expect(onChange).toHaveBeenCalledWith({ admissionQueue: "waiting" });
    expect(onChange).toHaveBeenCalledWith({ activeSpeaker: "nora" });
    expect(onChange).toHaveBeenCalledWith({ mic: "disabled" });
    expect(onChange).toHaveBeenCalledWith({ camera: "failed" });
    expect(onChange).toHaveBeenCalledWith({ hand: true });
    expect(onChange).toHaveBeenCalledWith({ role: "owner" });
    expect(onChange).toHaveBeenCalledWith({ capability: "observer" });
    expect(onChange).toHaveBeenCalledWith({ diagnostics: true });
    expect(onChange).toHaveBeenCalledWith({ features: { admission: false } });
    expect(onChange).toHaveBeenCalledWith({ skin: "chalk" });
    expect(onChange).toHaveBeenCalledWith({ palette: "oled-signal" });
    expect(onChange).toHaveBeenCalledWith({ texture: "slate" });
  });

  it("groups palettes by light and dark mode", () => {
    render(<PreviewGalleryToolbar search={VISIBLE} onChange={vi.fn()} />);
    openTab("Look");

    const palette = screen.getByLabelText("Palette");
    const groups = [...palette.querySelectorAll("optgroup")].map((group) => group.getAttribute("label"));
    expect(groups).toEqual(["Light", "Dark"]);
    expect(palette.querySelector('optgroup[label="Dark"] option[value="oled-signal"]')).not.toBeNull();
  });

  it("remembers the last tab and dock side across mounts", () => {
    const first = render(<Harness />);
    openTab("Media");
    fireEvent.click(screen.getByRole("button", { name: "Dock controls to the right" }));
    expect(screen.getByRole("region", { name: "Preview controls" }).parentElement?.className).toContain("sm:right-4");
    first.unmount();

    render(<Harness />);
    expect(screen.getByRole("tab", { name: "Media" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("region", { name: "Preview controls" }).parentElement?.className).toContain("sm:right-4");
    expect(screen.getByRole("button", { name: "Dock controls to the left" })).not.toBeNull();
  });

  it("moves between tabs with arrow keys", () => {
    render(<Harness />);
    const tablist = screen.getByRole("tablist", { name: "Preview control sections" });

    fireEvent.keyDown(tablist, { key: "ArrowRight" });
    expect(screen.getByRole("tab", { name: "Space" }).getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(tablist, { key: "ArrowLeft" });
    fireEvent.keyDown(tablist, { key: "ArrowLeft" });
    expect(screen.getByRole("tab", { name: "Look" }).getAttribute("aria-selected")).toBe("true");
  });

  it("keeps only the unobtrusive show handle keyboard reachable while chrome is hidden", () => {
    const { container } = render(<Harness initial={DEFAULT_PREVIEW_SEARCH} />);

    const showButton = screen.getByRole("button", { name: "Show preview controls" });
    expect(showButton.className).toContain("opacity-55");
    expect(showButton.parentElement?.className).toContain("bottom-24");
    expect(showButton.parentElement?.className).toContain("sm:bottom-4");
    expect(screen.queryByRole("region", { name: "Preview controls" })).toBeNull();
    expect(container.querySelectorAll("a, select, input")).toHaveLength(0);

    fireEvent.click(showButton);
    expect(screen.getByRole("region", { name: "Preview controls" })).not.toBeNull();
    expect(screen.getByRole("region", { name: "Preview controls" }).parentElement?.className).toContain("bottom-24");

    fireEvent.click(screen.getByRole("button", { name: "Hide preview controls" }));
    expect(screen.getByRole("button", { name: "Show preview controls" })).not.toBeNull();
    expect(container.querySelectorAll("a, select, input")).toHaveLength(0);
  });

  it("transfers focus, exposes the controlled region, and closes on Escape", () => {
    render(<Harness initial={DEFAULT_PREVIEW_SEARCH} />);
    const showButton = screen.getByRole("button", { name: "Show preview controls" });

    expect(showButton.getAttribute("aria-expanded")).toBe("false");
    const controlsId = showButton.getAttribute("aria-controls");
    expect(controlsId).not.toBeNull();

    fireEvent.click(showButton);
    const controls = screen.getByRole("region", { name: "Preview controls" });
    expect(controls.id).toBe(controlsId);
    expect(screen.getByRole("button", { name: "Hide preview controls" }).getAttribute("aria-expanded")).toBe("true");
    expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Preview controls" }));

    fireEvent.keyDown(controls, { key: "Escape" });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Show preview controls" }));
  });

  it("toggles the chrome with the backtick key unless the user is typing", () => {
    render(
      <div>
        <input aria-label="Chat message" />
        <Harness initial={DEFAULT_PREVIEW_SEARCH} />
      </div>,
    );

    fireEvent.keyDown(screen.getByLabelText("Chat message"), { key: "`" });
    expect(screen.queryByRole("region", { name: "Preview controls" })).toBeNull();

    fireEvent.keyDown(window, { key: "`" });
    expect(screen.getByRole("region", { name: "Preview controls" })).not.toBeNull();

    fireEvent.keyDown(window, { key: "`" });
    expect(screen.queryByRole("region", { name: "Preview controls" })).toBeNull();
  });

  it("steps through the current view's states with bracket keys and header arrows, wrapping around", () => {
    const onChange = vi.fn();
    render(<PreviewGalleryToolbar search={{ ...VISIBLE, view: "space", state: "happy" }} onChange={onChange} />);

    fireEvent.keyDown(window, { key: "]" });
    expect(onChange).toHaveBeenLastCalledWith({ state: "empty" });

    fireEvent.keyDown(window, { key: "[" });
    expect(onChange).toHaveBeenLastCalledWith({ state: "ended" });

    fireEvent.click(screen.getByRole("button", { name: "Next state: Empty" }));
    expect(onChange).toHaveBeenLastCalledWith({ state: "empty" });
    fireEvent.click(screen.getByRole("button", { name: "Previous state: Ended" }));
    expect(onChange).toHaveBeenLastCalledWith({ state: "ended" });
  });

  it("still steps states while the chrome is hidden", () => {
    const onChange = vi.fn();
    render(<PreviewGalleryToolbar search={DEFAULT_PREVIEW_SEARCH} onChange={onChange} />);

    fireEvent.keyDown(window, { key: "]" });
    expect(onChange).toHaveBeenLastCalledWith({ state: "joining" });
  });

  it("copies the full preview URL and resets to defaults", async () => {
    const writeText = vi.fn((_text: string) => Promise.resolve());
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const onChange = vi.fn();
    render(<PreviewGalleryToolbar search={{ ...VISIBLE, view: "space", state: "warning", participants: 5 }} onChange={onChange} />);

    fireEvent.click(screen.getByRole("button", { name: "Copy preview link" }));
    await screen.findByRole("button", { name: "Preview link copied" });
    expect(writeText).toHaveBeenCalledTimes(1);
    const copied = new URL(writeText.mock.calls[0]?.[0] ?? "");
    expect(copied.pathname).toBe("/sdk-preview");
    expect(copied.searchParams.get("state")).toBe("warning");
    expect(copied.searchParams.get("participants")).toBe("5");
    expect(copied.searchParams.get("chrome")).toBe("visible");

    fireEvent.click(screen.getByRole("button", { name: "Reset preview to defaults" }));
    expect(onChange).toHaveBeenLastCalledWith({ ...DEFAULT_PREVIEW_SEARCH, chrome: "visible" });
  });

  it("summarises the current state in the header", () => {
    render(<PreviewGalleryToolbar search={{ ...VISIBLE, view: "space", state: "reconnecting", participants: 9, layout: "grid" }} onChange={vi.fn()} />);

    const summary = screen.getByRole("region", { name: "Preview controls" }).querySelector("[aria-live]");
    expect(summary?.textContent).toContain("Space · Reconnecting");
    expect(summary?.textContent).toContain("9 participants · grid");
  });
});
