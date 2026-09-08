import { describe, expect, it } from "vitest";
import type { Participant } from "@q9labsai/chalk-client";
import { toListParticipants, toVideoParticipants } from "./space-selectors";

describe("Participant microphone projections", () => {
  it("does not report an active remote microphone as muted while its audio is still being pulled", () => {
    const remote: Participant = {
      participantId: "remote",
      displayName: "Remote",
      role: "collaborator",
      eligibleRoles: [],
      capabilities: [],
      handRaised: false,
      media: { microphone: "active", camera: "inactive", screen: "inactive" },
      presence: { state: "connected", speaking: false, activeSpeaker: false },
    };
    const tiles = toVideoParticipants([remote], [], "local", "Local", { microphone: { source: "microphone", state: "disabled", track: null }, camera: { source: "camera", state: "disabled", track: null }, screen: { source: "screen", state: "disabled", track: null } });
    expect(tiles.find((participant) => participant.id === "remote")?.isMuted).toBe(false);
  });
  it("keeps the local row on the same publication state as the local controls while the roster catches up", () => {
    expect(toListParticipants([{ id: "local", displayName: "Local", isLocal: true, isMuted: true, isVideoEnabled: false }], { local: { microphone: "active", camera: "active", screen: "inactive" } })[0]).toMatchObject({ isMuted: true, isVideoEnabled: false });
  });
});
