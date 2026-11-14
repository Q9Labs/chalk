// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { ParticipantsPanelSurface, type ParticipantListParticipant } from "./ParticipantsPanel";
import { ParticipantOptionsMenu } from "./participant-options-menu";

const person = (displayName: string, extra: Partial<ParticipantListParticipant> = {}): ParticipantListParticipant => ({ id: displayName, displayName, ...extra });
const crowd = ["Nora", "Sofia", "Malik", "Priya", "Eli", "June", "Tomás", "Lena", "Kenji"].map((name) => person(name));

async function mount(node: React.ReactNode) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const element = document.createElement("div");
  document.body.append(element);
  const root = createRoot(element);
  await act(async () => root.render(node));
  return { element, rerender: (next: React.ReactNode) => act(async () => root.render(next)), unmount: () => act(async () => root.unmount()) };
}

const names = (element: HTMLElement) => [...element.querySelectorAll(".call-person-name")].map((node) => node.textContent);
const click = (target: Element | null | undefined) => act(async () => target?.dispatchEvent(new MouseEvent("click", { bubbles: true })));

it("lists you first, then raised hands in order, then hosts, then the rest, with labels in a long call", async () => {
  const people = [person("Zed"), person("Boss", { isHost: true }), person("Late", { isHandRaised: true, handOrder: 2 }), person("Me", { isLocal: true }), person("Early", { isHandRaised: true, handOrder: 1 }), ...crowd];
  const { element, unmount } = await mount(<ParticipantsPanelSurface participants={people} />);
  expect(names(element).slice(0, 5)).toEqual(["Me", "Early", "Late", "Boss", "Zed"]);
  expect([...element.querySelectorAll(".call-people-section")].map((node) => node.textContent)).toEqual(["Raised hands 2", "In the call 11"]);
  expect([...element.querySelectorAll(".call-hand")].map((node) => node.getAttribute("aria-label"))).toEqual(["Hand raised, number 1", "Hand raised, number 2"]);
  await unmount();
});

it("shows no labels and no hand number in a small call with one hand", async () => {
  const { element, unmount } = await mount(<ParticipantsPanelSurface participants={[person("Me", { isLocal: true }), person("Akash", { isHandRaised: true, handOrder: 1 })]} />);
  expect(element.querySelector(".call-people-section")).toBeNull();
  expect(element.querySelector(".call-hand")?.getAttribute("aria-label")).toBe("Hand raised");
  await unmount();
});

it("highlights matches, counts them, drops the sections and clears", async () => {
  const people = [person("Me", { isLocal: true }), person("Priya", { isHandRaised: true, handOrder: 1 }), person("Amara Okafor"), person("Malik Haddad"), ...crowd.slice(4)];
  const { element, unmount } = await mount(<ParticipantsPanelSurface participants={people} />);
  const input = element.querySelector<HTMLInputElement>('input[aria-label="Search people"]');
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  await act(async () => {
    setValue?.call(input, "ma");
    input?.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(names(element)).toEqual(["Amara Okafor", "Malik Haddad"]);
  expect([...element.querySelectorAll(".call-person-name mark")].map((node) => node.textContent)).toEqual(["ma", "Ma"]);
  expect(element.querySelector(".call-people-count")?.textContent).toBe(`2 of ${people.length} people`);
  expect(element.querySelector(".call-people-section")).toBeNull();
  await click(element.querySelector('button[aria-label="Clear search"]'));
  expect(input?.value).toBe("");
  expect(element.querySelector(".call-people-count")).toBeNull();
  await unmount();
});

it("asks before removing someone, in the same menu", async () => {
  const onRemoveParticipant = vi.fn();
  const onClose = vi.fn();
  const { element, unmount } = await mount(<ParticipantOptionsMenu participant={person("Akash Rao")} variant="default" canManageParticipants onClose={onClose} onRemoveParticipant={onRemoveParticipant} />);
  await click([...element.querySelectorAll("button")].find((button) => button.textContent === "Remove"));
  expect(onRemoveParticipant).not.toHaveBeenCalled();
  expect(element.textContent).toContain("Remove Akash from the call?");
  await click([...element.querySelectorAll("button")].find((button) => button.textContent === "Cancel"));
  expect(element.textContent).not.toContain("from the call?");
  await click([...element.querySelectorAll("button")].find((button) => button.textContent === "Remove"));
  await click([...element.querySelectorAll("button")].filter((button) => button.textContent === "Remove").at(-1));
  expect(onRemoveParticipant).toHaveBeenCalledWith("Akash Rao");
  await unmount();
});

it("gives a guest only the volume control for someone else, and no host actions", async () => {
  const { element, unmount } = await mount(<ParticipantOptionsMenu participant={person("Nora")} variant="default" canManageParticipants={false} onClose={() => undefined} participantVolumes={new Map()} onParticipantVolumeChange={() => undefined} />);
  expect(element.textContent).toContain("Volume");
  expect(element.textContent).not.toMatch(/Mute|Remove|camera/);
  await unmount();
});

it("puts who can join beside mute everyone for a host, changes it from the menu, and shows neither to a guest", async () => {
  const people = [person("Me", { isLocal: true }), person("Nora")];
  const changes: string[] = [];
  const onAdmissionPolicyChange = async (policy: string) => void changes.push(policy);
  const host = await mount(<ParticipantsPanelSurface participants={people} canManageAdmission admissionPolicy="open" onAdmissionPolicyChange={onAdmissionPolicyChange} onMuteEveryone={async () => undefined} />);
  const controls = host.element.querySelector(".call-host-controls");
  expect([...(controls?.querySelectorAll("button") ?? [])].map((button) => button.textContent)).toEqual(["Anyone with the link", "Mute everyone"]);
  expect(controls?.querySelector("button")?.getAttribute("aria-label")).toBe("Who can join: Anyone with the link");
  await click(controls?.querySelector("button"));
  const items = [...document.querySelectorAll('[role="menuitemcheckbox"], [role="menuitemradio"], [role="menuitem"]')];
  expect(items.map((item) => item.textContent)).toEqual(["Anyone with the linkPeople join right away", "Ask to joinYou let each person in"]);
  await click(items[1]);
  expect(changes).toEqual(["knock"]);
  await host.unmount();
  const guest = await mount(<ParticipantsPanelSurface participants={people} admissionPolicy="open" />);
  expect(guest.element.querySelector(".call-host-controls")).toBeNull();
  await guest.unmount();
});
