import { expect, it } from "vitest";
import { entranceAutoplayDecision } from "./entrance-autoplay";

const automatic = { automaticEntry: true, reloadMarker: false, automaticName: "Ada", rememberedDevices: true };

it("keeps automatic resume and arrival only when entry may start without a gesture", () => {
  expect(entranceAutoplayDecision({ ...automatic, reloadMarker: true })).toBe("resume");
  expect(entranceAutoplayDecision(automatic)).toBe("arrive");
  expect(entranceAutoplayDecision({ ...automatic, automaticEntry: false })).toBe("lobby");
  expect(entranceAutoplayDecision({ ...automatic, automaticEntry: false, reloadMarker: true })).toBe("lobby");
});

it("keeps the lobby for a visitor without both remembered entry facts", () => {
  expect(entranceAutoplayDecision({ ...automatic, automaticName: "" })).toBe("lobby");
  expect(entranceAutoplayDecision({ ...automatic, rememberedDevices: false })).toBe("lobby");
});
