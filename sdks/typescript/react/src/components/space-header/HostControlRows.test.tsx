// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { CallDetails } from "./CallDetails";
import type { CallHostControls } from "./space-header-contract";

afterEach(() => document.body.replaceChildren());

function mount(hostControls?: CallHostControls) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const root = createRoot(document.body.appendChild(document.createElement("div")));
  act(() => root.render(<CallDetails spaceName="Q9 team" shareUrl="https://chalk.test/q9" hostControls={hostControls} sounds onSoundsChange={() => {}} onDialog={() => {}} onClose={() => {}} />));
  return root;
}
const rowNamed = (name: string) => [...document.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.startsWith(name));
const click = async (element: Element | undefined) => {
  expect(element, "an element to click").toBeDefined();
  await act(async () => element?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
};
const alerts = () => [...document.querySelectorAll("[role=alert]")].map((alert) => alert.textContent);

it("shows no host row to someone without host controls", () => {
  mount();
  expect(rowNamed("Mute everyone")).toBeUndefined();
  mount({});
  expect(document.querySelector("#chalk-details-mute")).toBeNull();
});

it("asks before muting everyone and mutes through the row", async () => {
  let muted = 0;
  mount({ muteEveryone: { unmutedCount: 2, onMute: async () => void muted++ } });
  const row = rowNamed("Mute everyone");
  const confirm = document.querySelector<HTMLElement>("#chalk-details-mute");
  expect(confirm?.hidden).toBe(true);
  await click(row);
  expect(confirm?.hidden).toBe(false);
  expect(confirm?.textContent).toContain("Mute everyone?2 people will be muted. They can unmute themselves.");
  await click(rowNamed("Cancel"));
  expect(confirm?.hidden).toBe(true);
  expect(muted).toBe(0);
  await click(row);
  await click(rowNamed("Mute 2 people"));
  expect(muted).toBe(1);
  expect(confirm?.hidden).toBe(true);
});

it("shows the failure from muting everyone in the menu, and disables the row when nobody is unmuted", async () => {
  mount({ muteEveryone: { unmutedCount: 1, onMute: () => Promise.reject(new Error("Not allowed to mute")) } });
  await click(rowNamed("Mute everyone"));
  expect(document.querySelector("#chalk-details-mute")?.textContent).toContain("1 person will be muted");
  await click(rowNamed("Mute 1 person"));
  expect(alerts()).toEqual(["Not allowed to mute"]);
  document.body.replaceChildren();
  mount({ muteEveryone: { unmutedCount: 0, onMute: async () => {} } });
  expect(rowNamed("Mute everyone")?.disabled).toBe(true);
});

it("offers 5, 10 and 20 minutes and starts the one that is clicked", async () => {
  const minutes: number[] = [];
  mount({ focusAllowance: { active: false, onAllow: async (value) => void minutes.push(value), onEnd: async () => {} } });
  const row = rowNamed("Allow other tabs");
  expect(row?.textContent).toContain("Off");
  await click(row);
  expect(["5 min", "10 min", "20 min"].map((name) => rowNamed(name)?.textContent)).toEqual(["5 min", "10 min", "20 min"]);
  await click(rowNamed("10 min"));
  expect(minutes).toEqual([10]);
});

it("counts the allowance down when this tab opened it, and just says Allowed after a reload", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  let ended = 0;
  const onEnd = async () => void ended++;
  mount({ focusAllowance: { active: true, until: { endsAtMs: 5 * 60_000, minutes: 5 }, onAllow: async () => {}, onEnd } });
  expect(rowNamed("Allow other tabs")?.textContent).toContain("5:00 left");
  await act(async () => vi.advanceTimersByTime(65_000));
  expect(rowNamed("Allow other tabs")?.textContent).toContain("3:55 left");
  await click(rowNamed("Allow other tabs"));
  await click(rowNamed("End allowance"));
  expect(ended).toBe(1);
  vi.useRealTimers();
  document.body.replaceChildren();
  mount({ focusAllowance: { active: true, onAllow: async () => {}, onEnd } });
  expect(rowNamed("Allow other tabs")?.textContent).toContain("Allowed");
  expect(rowNamed("Allow other tabs")?.textContent).not.toContain("left");
});

it("shows why the allowance could not change", async () => {
  mount({ focusAllowance: { active: false, onAllow: () => Promise.reject(new Error("Not allowed to change Focus")), onEnd: async () => {} } });
  await click(rowNamed("Allow other tabs"));
  await click(rowNamed("5 min"));
  expect(alerts()).toEqual(["Not allowed to change Focus"]);
});
