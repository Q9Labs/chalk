// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { TranscriptLanguage } from "@chalk/transcript-language";
import { LanguagePicker } from "./LanguagePicker";

beforeEach(() => {
  window.localStorage.clear();
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function Harness({ initial, allowDefault = false, onChange }: { readonly initial: TranscriptLanguage | null; readonly allowDefault?: boolean; readonly onChange?: (value: TranscriptLanguage | null) => void }) {
  const [value, setValue] = useState(initial);
  return (
    <>
      <span id="label">Transcript language</span>
      <LanguagePicker
        id="picker"
        labelledBy="label"
        value={value}
        allowDefault={allowDefault}
        onChange={(next) => {
          setValue(next);
          onChange?.(next);
        }}
      />
    </>
  );
}

const trigger = () => screen.getByRole("button", { name: /Transcript language/ });
const search = () => screen.getByRole("combobox", { name: "Search languages" });
const options = () => screen.getAllByRole("option").map((item) => item.textContent ?? "");

it("closed, it shows the chosen language with its flag and native name", () => {
  render(<Harness initial="ur" />);
  expect(trigger().textContent).toContain("Urdu");
  expect(trigger().textContent).toContain("اردو");
  expect(trigger().querySelector("img")?.getAttribute("src")).toBe("/flags/pk.svg");
  expect(trigger().getAttribute("aria-expanded")).toBe("false");
});

it("opens on click with search focused and the chosen language highlighted", () => {
  render(<Harness initial="ur" />);
  fireEvent.click(trigger());
  expect(document.activeElement).toBe(search());
  expect(trigger().getAttribute("aria-expanded")).toBe("true");
  const selected = screen.getAllByRole("option", { selected: true });
  expect(selected.length).toBeGreaterThan(0);
  expect(search().getAttribute("aria-activedescendant")).toBe(selected[0]?.id);
});

it("shows Automatic first, then recent and suggested, then every language A to Z", () => {
  window.localStorage.setItem("chalk.transcript-language.recent", '["ur","en"]');
  render(<Harness initial="ur" allowDefault />);
  fireEvent.click(trigger());
  const groups = screen.getAllByRole("group").map((group) => group.getAttribute("aria-label"));
  expect(groups).toEqual(["Automatic", "Recent", "Suggested", "All languages"]);
  const automatic = within(screen.getByRole("group", { name: "Automatic" })).getAllByRole("option");
  expect(automatic.map((item) => item.querySelector(".lp-name")?.textContent)).toEqual(["Use account default", "Auto-detect"]);
  const all = within(screen.getByRole("group", { name: "All languages" })).getAllByRole("option");
  expect(all).toHaveLength(100);
});

it("leaves out the account default row unless the setting can inherit", () => {
  render(<Harness initial="auto" />);
  fireEvent.click(trigger());
  expect(screen.queryByRole("option", { name: /Use account default/ })).toBeNull();
  expect(screen.getByRole("option", { name: /Auto-detect/ })).toBeTruthy();
});

it("searches, puts the best match first and chooses it with Enter", () => {
  const change = vi.fn();
  render(<Harness initial="auto" onChange={change} />);
  fireEvent.click(trigger());
  fireEvent.change(search(), { target: { value: "ur" } });
  expect(screen.getAllByRole("group").map((group) => group.getAttribute("aria-label"))).toEqual(["Best match", "Also contains"]);
  expect(options()[0]).toContain("Urdu");
  expect(screen.getByRole("status").textContent).toMatch(/^\d+ languages$/);
  fireEvent.keyDown(search(), { key: "Enter" });
  expect(change).toHaveBeenCalledWith("ur");
  expect(screen.queryByRole("option")).toBeNull();
  expect(document.activeElement).toBe(trigger());
  expect(trigger().textContent).toContain("Urdu");
});

it("moves with the arrow keys, stops at the ends and jumps with Home and End", () => {
  const change = vi.fn();
  render(<Harness initial="auto" onChange={change} />);
  fireEvent.click(trigger());
  const list = () => screen.getAllByRole("option");
  fireEvent.keyDown(search(), { key: "ArrowUp" });
  expect(search().getAttribute("aria-activedescendant")).toBe(list()[0]?.id);
  fireEvent.keyDown(search(), { key: "End" });
  expect(search().getAttribute("aria-activedescendant")).toBe(list().at(-1)?.id);
  fireEvent.keyDown(search(), { key: "ArrowDown" });
  expect(search().getAttribute("aria-activedescendant")).toBe(list().at(-1)?.id);
  fireEvent.keyDown(search(), { key: "Home" });
  fireEvent.keyDown(search(), { key: "ArrowDown" });
  fireEvent.keyDown(search(), { key: "Enter" });
  expect(change).toHaveBeenCalledTimes(1);
});

it("closes on Escape without changing the value and returns focus to the control", () => {
  const change = vi.fn();
  render(<Harness initial="ur" onChange={change} />);
  fireEvent.click(trigger());
  fireEvent.change(search(), { target: { value: "fr" } });
  fireEvent.keyDown(search(), { key: "Escape" });
  expect(screen.queryByRole("option")).toBeNull();
  expect(change).not.toHaveBeenCalled();
  expect(document.activeElement).toBe(trigger());
  fireEvent.click(trigger());
  expect(search()).toHaveProperty("value", "");
});

it("opens with ArrowDown from the closed control", () => {
  render(<Harness initial="ur" />);
  fireEvent.keyDown(trigger(), { key: "ArrowDown" });
  expect(trigger().getAttribute("aria-expanded")).toBe("true");
});

it("says why nothing matches and offers both ways out", () => {
  const change = vi.fn();
  render(<Harness initial="ur" onChange={change} />);
  fireEvent.click(trigger());
  fireEvent.change(search(), { target: { value: "klingon" } });
  expect(screen.getByText("No language matches “klingon”")).toBeTruthy();
  expect(screen.getByText(/100 languages its transcriber supports/)).toBeTruthy();
  expect(screen.getByRole("status").textContent).toBe("No languages match");
  expect(search().hasAttribute("aria-activedescendant")).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "Clear search" }));
  expect(screen.getAllByRole("option").length).toBeGreaterThan(100);
  fireEvent.change(search(), { target: { value: "klingon" } });
  fireEvent.click(screen.getByRole("button", { name: "Use Auto-detect" }));
  expect(change).toHaveBeenCalledWith("auto");
});

it("can choose the account default and ignores a choice that changes nothing", () => {
  const change = vi.fn();
  render(<Harness initial="ur" allowDefault onChange={change} />);
  fireEvent.click(trigger());
  fireEvent.click(screen.getByRole("option", { name: /Use account default/ }));
  expect(change).toHaveBeenCalledWith(null);
  expect(trigger().textContent).toContain("Use account default");
  fireEvent.click(trigger());
  fireEvent.click(screen.getByRole("option", { name: /Use account default/ }));
  expect(change).toHaveBeenCalledTimes(1);
});

it("closes when the person clicks elsewhere", () => {
  render(<Harness initial="ur" />);
  fireEvent.click(trigger());
  fireEvent.pointerDown(document.body);
  expect(screen.queryByRole("option")).toBeNull();
});

it("keeps focus inside while Tab moves between its own buttons, and closes when focus leaves", () => {
  render(<Harness initial="ur" />);
  fireEvent.click(trigger());
  fireEvent.change(search(), { target: { value: "klingon" } });
  fireEvent.blur(search(), { relatedTarget: screen.getByRole("button", { name: "Use Auto-detect" }) });
  expect(screen.getByRole("button", { name: "Use Auto-detect" })).toBeTruthy();
  fireEvent.blur(screen.getByRole("button", { name: "Use Auto-detect" }), { relatedTarget: document.body });
  expect(screen.queryByRole("combobox")).toBeNull();
});

it("leaves Enter and the arrows to the input method while it composes text", () => {
  const change = vi.fn();
  render(<Harness initial="ur" onChange={change} />);
  fireEvent.click(trigger());
  fireEvent.change(search(), { target: { value: "に" } });
  fireEvent.keyDown(search(), { key: "Enter", isComposing: true });
  expect(change).not.toHaveBeenCalled();
  expect(screen.getByRole("combobox")).toBeTruthy();
});

it("finds a language by the start of its code", () => {
  render(<Harness initial="ur" />);
  fireEvent.click(trigger());
  fireEvent.change(search(), { target: { value: "yu" } });
  expect(options().some((name) => name.includes("Cantonese"))).toBe(true);
});

it("can't be opened while disabled or loading, and says what it is waiting for", () => {
  const { rerender } = render(<LanguagePicker id="picker" labelledBy="label" value="ur" onChange={vi.fn()} disabled />);
  expect(screen.getByRole("button")).toHaveProperty("disabled", true);
  rerender(<LanguagePicker id="picker" labelledBy="label" value="ur" onChange={vi.fn()} loading loadingLabel="Saving…" />);
  const busy = screen.getByRole("button");
  expect(busy).toHaveProperty("disabled", true);
  expect(busy.getAttribute("aria-busy")).toBe("true");
  expect(busy.textContent).toContain("Saving…");
  fireEvent.keyDown(busy, { key: "ArrowDown" });
  expect(screen.queryByRole("option")).toBeNull();
});

it("becomes a bottom sheet on a phone", () => {
  vi.stubGlobal("matchMedia", () => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  const { container } = render(<Harness initial="ur" />);
  fireEvent.click(trigger());
  expect(container.querySelector(".scrim .lp-pop.sheet")).toBeTruthy();
  const scrim = container.querySelector(".scrim");
  if (!scrim) throw new Error("no sheet");
  fireEvent.pointerDown(scrim);
  expect(screen.queryByRole("option")).toBeNull();
});
