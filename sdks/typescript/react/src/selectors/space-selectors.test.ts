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
      media: { microphone: "active", camera: "inactive", screenShare: "inactive" },
      presence: { state: "connected", speaking: false, activeSpeaker: false },
    };
    const tiles = toVideoParticipants([remote], [], "local", "Local", { microphone: { source: "microphone", state: "disabled", track: null }, camera: { source: "camera", state: "disabled", track: null }, screen: { source: "screen", state: "disabled", track: null } });
    expect(tiles.find((participant) => participant.id === "remote")?.isMuted).toBe(false);
  });
  it("detaches a paused remote camera and reattaches it when state resumes", () => {
    const remote: Participant = {
      participantId: "remote",
      displayName: "Remote",
      role: "collaborator",
      eligibleRoles: [],
      capabilities: [],
      handRaised: false,
      media: { microphone: "inactive", camera: "inactive", screenShare: "inactive" },
      presence: { state: "connected", speaking: false, activeSpeaker: false },
    };
    const track = {} as MediaStreamTrack;
    const localMedia = { microphone: { source: "microphone" as const, state: "disabled" as const, track: null }, camera: { source: "camera" as const, state: "disabled" as const, track: null }, screen: { source: "screen" as const, state: "disabled" as const, track: null } };
    const pulled = [{ participantId: "remote", source: "camera" as const, publicationId: "publication-1", track }];

    const paused = toVideoParticipants([remote], pulled, "local", "Local", localMedia).find((participant) => participant.id === "remote");
    expect(paused).toMatchObject({ isVideoEnabled: false });
    expect(paused?.videoTrack).toBeUndefined();

    const resumed = toVideoParticipants([{ ...remote, media: { ...remote.media, camera: "active" } }], pulled, "local", "Local", localMedia).find((participant) => participant.id === "remote");
    expect(resumed).toMatchObject({ isVideoEnabled: true, videoTrack: track });
  });
  it("keeps the local row on the same publication state as the local controls while the roster catches up", () => {
    expect(toListParticipants([{ id: "local", displayName: "Local", isLocal: true, isMuted: true, isVideoEnabled: false }], { local: { microphone: "active", camera: "active", screenShare: "inactive" } })[0]).toMatchObject({ isMuted: true, isVideoEnabled: false });
  });
});
