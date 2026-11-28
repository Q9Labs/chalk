import { expect, it } from "vitest";
import type { Participant, ParticipantFocus } from "@q9labsai/chalk-client";
import { effectiveFocus } from "./space-selectors";

function person(id: string, identityId: string, focus: ParticipantFocus | undefined, state: Participant["presence"]["state"] = "connected"): Participant {
  return {
    identityId,
    participantId: id,
    displayName: id,
    role: "collaborator",
    eligibleRoles: [],
    capabilities: [],
    handRaised: false,
    media: { microphone: "inactive", camera: "inactive", screenShare: "inactive" },
    presence: { state, speaking: false, activeSpeaker: false },
    focus,
  };
}

it("shows a same-identity person as active while any connected device is active", () => {
  const phone = person("phone", "person", { appState: "background" });
  const laptop = person("laptop", "person", { appState: "active" });
  expect(effectiveFocus(phone, [phone, laptop])?.appState).toBe("active");
});

it("keeps away state when the other device is disconnected, another person, or also away", () => {
  const phone = person("phone", "person", { appState: "background" });
  const disconnected = person("laptop", "person", { appState: "active" }, "disconnected");
  const otherPerson = person("other", "someone-else", { appState: "active" });
  const alsoAway = person("tablet", "person", { appState: "inactive" });
  expect(effectiveFocus(phone, [phone, disconnected])?.appState).toBe("background");
  expect(effectiveFocus(phone, [phone, otherPerson])?.appState).toBe("background");
  expect(effectiveFocus(phone, [phone, alsoAway])?.appState).toBe("background");
});
