import { expect, it } from "vitest";
import { deviceHint, participantDevice } from "./participant-device";
import type { Participant } from "./participant-types";

const person = (id: string, device: Pick<Participant, "deviceKind" | "deviceType" | "identityId"> = {}, state: "connected" | "disconnected" = "connected"): Participant => ({
  participantId: id,
  displayName: id,
  role: "guest",
  eligibleRoles: ["guest"],
  capabilities: [],
  handRaised: false,
  media: { microphone: "active", camera: "inactive", screenShare: "inactive" },
  presence: { state, speaking: false, activeSpeaker: false },
  ...device,
});

it("names each declared device in short sentence case and marks which ones earn a tile badge", () => {
  const cases = [
    ["iphone", "iPhone", "iPhone", "phone"],
    ["ipad", "iPad", "iPad", "tablet"],
    ["android_phone", "Android", "an Android phone", "phone"],
    ["android_tablet", "Android tablet", "an Android tablet", "tablet"],
    ["android_foldable", "Foldable", "a foldable", "foldable"],
    ["mac", "Mac", "a Mac", "computer"],
    ["windows", "Windows", "a Windows computer", "computer"],
    ["linux", "Linux", "a Linux computer", "computer"],
    ["chromeos", "Chromebook", "a Chromebook", "computer"],
  ] as const;
  for (const [deviceKind, label, joinedFrom, form] of cases) expect(participantDevice(person("a", { deviceKind }))).toEqual({ label, joinedFrom, form });
});

it("falls back to the coarse type when a client declared no device, and to nothing when Sync sent neither", () => {
  expect(participantDevice(person("a", { deviceType: "phone" }))).toEqual({ label: "Phone", joinedFrom: "a phone", form: "phone" });
  expect(participantDevice(person("a", { deviceType: "computer" }))).toEqual({ label: "Computer", joinedFrom: "a computer", form: "computer" });
  expect(participantDevice(person("a"))).toBeUndefined();
  expect(participantDevice(undefined)).toBeUndefined();
});

it("prefers the declared device over the coarse type", () => {
  expect(participantDevice(person("a", { deviceType: "tablet", deviceKind: "android_foldable" }))?.label).toBe("Foldable");
});

it("always gives the device, and counts the devices of one person who is connected twice", () => {
  const phone = person("phone", { identityId: "ada", deviceKind: "iphone" });
  const laptop = person("laptop", { identityId: "ada", deviceKind: "mac" });
  expect(deviceHint(person("solo", { identityId: "bo", deviceKind: "windows" }), [phone, laptop])).toBe("Windows");
  expect(deviceHint(phone, [phone, laptop])).toBe("iPhone · 2 devices");
  expect(deviceHint(laptop, [phone, laptop])).toBe("Mac · 2 devices");
  expect(deviceHint(person("noHint", { identityId: "cy" }), [phone, laptop])).toBeUndefined();
});

it("does not count a device that dropped out", () => {
  const phone = person("phone", { identityId: "ada", deviceKind: "iphone" });
  const gone = person("laptop", { identityId: "ada", deviceKind: "mac" }, "disconnected");
  expect(deviceHint(phone, [phone, gone])).toBe("iPhone");
});
