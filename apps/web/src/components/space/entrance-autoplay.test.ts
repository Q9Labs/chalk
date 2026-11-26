import { expect, it } from "vitest";
import { entranceAutoplayDecision } from "./entrance-autoplay";

const automatic = { autoplayAllowed: true, automated: false, reloadMarker: false, automaticName: "Ada", rememberedDevices: true };

it("keeps automatic resume and arrival only when the browser allows sound", () => {
  expect(entranceAutoplayDecision({ ...automatic, reloadMarker: true })).toBe("resume");
  expect(entranceAutoplayDecision(automatic)).toBe("arrive");
  expect(entranceAutoplayDecision({ ...automatic, autoplayAllowed: false })).toBe("lobby");
  expect(entranceAutoplayDecision({ ...automatic, autoplayAllowed: false, reloadMarker: true })).toBe("lobby");
});

it("keeps unattended entry for an automated browser even when sound is blocked", () => {
  expect(entranceAutoplayDecision({ ...automatic, automated: true, autoplayAllowed: false })).toBe("arrive");
  expect(entranceAutoplayDecision({ ...automatic, automated: true, autoplayAllowed: false, reloadMarker: true })).toBe("resume");
});

it("keeps the lobby for a visitor without both remembered entry facts", () => {
  expect(entranceAutoplayDecision({ ...automatic, automaticName: "" })).toBe("lobby");
  expect(entranceAutoplayDecision({ ...automatic, rememberedDevices: false })).toBe("lobby");
});
