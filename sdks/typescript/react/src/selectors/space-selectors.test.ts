import type { LocalMedia, Participant, RemoteMedia } from "@q9labsai/chalk-client";
import { describe, expect, it } from "vitest";

import { toAudioParticipants, toListParticipants, toParticipantNames, toVideoParticipants } from "./space-selectors";

const localMedia: Readonly<Record<"microphone" | "camera" | "screen", LocalMedia>> = {
  microphone: { source: "microphone", state: "enabled", track: null },
  camera: { source: "camera", state: "disabled", track: null },
  screen: { source: "screen", state: "disabled", track: null },
};

const participant = (overrides: Partial<Participant> = {}): Participant => ({
  participantId: "remote",
  displayName: "Grace",
  handRaised: false,
  role: "participant",
  eligibleRoles: ["participant"],
  capabilities: [],
  media: { microphone: "inactive", camera: "inactive", screenShare: "inactive" },
  ...overrides,
});

const media = (source: RemoteMedia["source"], track: MediaStreamTrack, participantId = "remote"): RemoteMedia => ({
  participantId,
  source,
  publicationId: `${participantId}-${source}`,
  track,
});

describe("space space selectors", () => {
  it("gives the synced local participant name precedence over the fallback display name", () => {
    const participants = [participant({ participantId: "local", displayName: "Synced Ada" })];

    expect(toVideoParticipants(participants, [], "local", "Fallback Ada", localMedia)[0]?.displayName).toBe("Synced Ada");
    expect(toParticipantNames(participants, "local", "Fallback Ada")).toEqual({ local: "Synced Ada" });
  });

  it("maps remote camera and screen-share tracks independently", () => {
    const cameraTrack = { kind: "video" } as MediaStreamTrack;
    const screenTrack = { kind: "video" } as MediaStreamTrack;

    expect(toVideoParticipants([participant()], [media("camera", cameraTrack), media("screen", screenTrack)], "local", "Ada", localMedia)).toEqual([
      expect.objectContaining({ id: "local" }),
      expect.objectContaining({ id: "remote", isVideoEnabled: true, isScreenSharing: true, videoTrack: cameraTrack, screenShareTrack: screenTrack }),
    ]);
  });

  it("groups microphone and screen-share audio tracks by participant", () => {
    const microphoneTrack = { kind: "audio" } as MediaStreamTrack;
    const screenTrack = { kind: "audio" } as MediaStreamTrack;

    expect(toAudioParticipants([media("microphone", microphoneTrack), media("screen", screenTrack)])).toEqual([{ id: "remote", audioTrack: microphoneTrack, screenShareAudioTrack: screenTrack }]);
  });

  it("uses known media states and falls back for unknown participant media", () => {
    const tiles = [
      { id: "active", displayName: "Active", isMuted: true, isVideoEnabled: false },
      { id: "inactive", displayName: "Inactive", isMuted: false, isVideoEnabled: true },
      { id: "unknown", displayName: "Unknown", isMuted: true, isVideoEnabled: false },
    ];
    const participantMedia: Readonly<Record<string, Participant["media"]>> = {
      active: { microphone: "active", camera: "active", screenShare: "unknown" },
      inactive: { microphone: "inactive", camera: "inactive", screenShare: "unknown" },
      unknown: { microphone: "unknown", camera: "unknown", screenShare: "unknown" },
    };

    expect(toListParticipants(tiles, participantMedia)).toEqual([
      expect.objectContaining({ id: "active", isMuted: false, isVideoEnabled: true }),
      expect.objectContaining({ id: "inactive", isMuted: true, isVideoEnabled: false }),
      expect.objectContaining({ id: "unknown", isMuted: true, isVideoEnabled: false }),
    ]);
  });
});
