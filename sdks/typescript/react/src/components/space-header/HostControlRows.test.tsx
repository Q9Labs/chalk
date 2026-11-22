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

it("shows neither row to someone without host controls", () => {
  mount();
  expect(rowNamed("Who can join")).toBeUndefined();
  expect(rowNamed("Mute everyone")).toBeUndefined();
  mount({});
  expect(document.querySelector("#chalk-details-join, #chalk-details-mute")).toBeNull();
});

it("shows the current policy and changes it through the row", async () => {
  const policies: string[] = [];
  mount({ whoCanJoin: { policy: "open", onChange: async (policy) => void policies.push(policy) } });
  const row = rowNamed("Who can join");
  expect(row?.textContent).toContain("Anyone with the link");
  expect(row?.getAttribute("aria-expanded")).toBe("false");
  await click(row);
  expect(row?.getAttribute("aria-expanded")).toBe("true");
  const options = [...document.querySelectorAll<HTMLButtonElement>("#chalk-details-join button")];
  expect(options.map((option) => [option.textContent, option.getAttribute("aria-pressed")])).toEqual([
    ["Anyone with the linkPeople join right away", "true"],
    ["Ask to joinYou let each person in", "false"],
  ]);
  await click(options[1]);
  expect(policies).toEqual(["knock"]);
  expect(row?.getAttribute("aria-expanded")).toBe("false");
});

it("disables the row while a policy change is pending and says when it fails", async () => {
  let fail: (cause: Error) => void = () => {};
  mount({ whoCanJoin: { policy: "knock", onChange: () => new Promise<void>((_, reject) => (fail = reject)) } });
  const row = rowNamed("Who can join");
  expect(row?.textContent).toContain("Ask to join");
  await click(row);
  await click(document.querySelectorAll("#chalk-details-join button")[0]);
  expect(row?.disabled).toBe(true);
  await act(async () => fail(new Error("refused")));
  expect(row?.disabled).toBe(false);
  expect(alerts()).toEqual(["Couldn’t change who can join. Try again."]);
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
